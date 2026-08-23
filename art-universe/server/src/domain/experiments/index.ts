import crypto from 'node:crypto';
import type { Db } from '../../infra/db.js';
import type { Clock } from '../../infra/clock.js';
import { systemClock } from '../../infra/clock.js';
import { internalId } from '../../infra/ids.js';
import type { AnalyticsService } from '../analytics/index.js';

/** Surfaces autonomy may touch on its own (§17). */
export const LOW_RISK_SURFACES = [
  'spacing', 'motion_speed', 'clustering', 'search_suggestions', 'discovery_presentation',
  'relationship_visibility', 'ui_placement', 'onboarding_hints', 'performance',
  'gravity_presentation', 'recommendation_diversity', 'animation_timing'
] as const;

/** Surfaces that always require a human decision. Autonomy may never change these. */
export const PROTECTED_SURFACES = [
  'art_key_security', 'authentication', 'upload_session_security', 'privacy_policy',
  'moderation_policy', 'content_safety', 'data_collection', 'data_retention',
  'admin_permissions', 'external_data_sharing', 'legal_consent', 'security_controls',
  'anonymous_ownership'
] as const;

export type Surface = (typeof LOW_RISK_SURFACES)[number] | (typeof PROTECTED_SURFACES)[number];

export const isAutonomous = (surface: string): boolean =>
  (LOW_RISK_SURFACES as readonly string[]).includes(surface);

export interface Observation {
  key: string;
  surface: Surface;
  problem: string;
  evidence: string;
  severity: number;
  hypothesis: string;
  change: string;
  variant: Record<string, number | string | boolean>;
  metrics: string[];
}

export interface ExperimentRecord {
  id: string;
  key: string;
  surface: string;
  problem: string;
  evidence: string;
  hypothesis: string;
  change: string;
  risk: 'low' | 'medium' | 'high';
  design: string;
  audiencePct: number;
  metrics: string[];
  variant: Record<string, unknown>;
  status: string;
  requiresHuman: boolean;
  result: string | null;
  decision: string | null;
  rollbackState: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * The self-evolving soul.
 *
 * observe -> understand -> propose -> test -> measure -> keep / modify / roll back.
 *
 * Every experiment starts from an observed problem, runs on a small share of
 * anonymous sessions, and carries the state needed to undo it. A proposal that
 * touches a protected surface is never applied: it is recorded as `blocked` and
 * left for a person.
 */
export class EvolutionEngine {
  constructor(
    private db: Db,
    private analytics: AnalyticsService,
    private clock: Clock = systemClock
  ) {}

  /** Look at anonymous aggregates and describe what looks wrong. */
  observe(): Observation[] {
    const counts = this.analytics.countsByName();
    const observations: Observation[] = [];

    const searchToSelect = this.analytics.bucketsMissingFollowUp('search_submitted', 'artwork_selected');
    const searchTotal = searchToSelect.with + searchToSelect.without;
    if (searchTotal >= 20 && searchToSelect.without / searchTotal > 0.55) {
      observations.push({
        key: 'search_dead_end',
        surface: 'search_suggestions',
        problem: 'Most searches end without anyone opening an artwork.',
        evidence: `${searchToSelect.without}/${searchTotal} search sessions selected nothing.`,
        severity: searchToSelect.without / searchTotal,
        hypothesis:
          'Results arrive too tightly clustered to read, so nothing invites a closer look.',
        change: 'Widen post-search spacing and surface a few starting-point suggestions.',
        variant: { searchSpread: 1.35, showSuggestions: true },
        metrics: ['artwork_selected_after_search', 'search_refined', 'explore_similar']
      });
    }

    const uploads = this.analytics.bucketsMissingFollowUp('upload_chosen', 'upload_published');
    const uploadTotal = uploads.with + uploads.without;
    if (uploadTotal >= 15 && uploads.without / uploadTotal > 0.4) {
      observations.push({
        key: 'upload_abandonment',
        surface: 'onboarding_hints',
        problem: 'Creators choose an image and then leave before it is published.',
        evidence: `${uploads.without}/${uploadTotal} chosen images never reached publication.`,
        severity: uploads.without / uploadTotal,
        hypothesis: 'The wait feels open-ended, so people give up before approval.',
        change: 'Show the forming constellation earlier during the check.',
        variant: { earlyConstellation: true },
        metrics: ['upload_published', 'upload_abandoned']
      });
    }

    if ((counts.gesture_failed ?? 0) > (counts.camera_moved ?? 1) * 0.12) {
      observations.push({
        key: 'gesture_friction',
        surface: 'motion_speed',
        problem: 'Navigation gestures are failing often enough to be noticed.',
        evidence: `${counts.gesture_failed ?? 0} failed gestures against ${counts.camera_moved ?? 0} camera moves.`,
        severity: 0.5,
        hypothesis: 'Zoom responds too sharply, so pinch and wheel overshoot.',
        change: 'Soften zoom acceleration and lengthen inertia.',
        variant: { zoomDamping: 0.82, inertia: 1.2 },
        metrics: ['gesture_failed', 'camera_moved']
      });
    }

    if ((counts.render_slow ?? 0) > 25) {
      observations.push({
        key: 'render_pressure',
        surface: 'performance',
        problem: 'Frames are being dropped on real devices.',
        evidence: `${counts.render_slow} slow-frame reports.`,
        severity: 0.6,
        hypothesis: 'Too many artworks are resident near the viewport at once.',
        change: 'Reduce the resident node budget and load derivatives later.',
        variant: { nodeBudget: 260, lazyMargin: 0.7 },
        metrics: ['render_slow']
      });
    }

    for (const o of observations) this.log(null, 'observed', o.problem, { evidence: o.evidence });
    return observations;
  }

  /** Turn an observation into an experiment — or into a blocked proposal. */
  propose(o: Observation, audiencePct = 0.15): ExperimentRecord {
    const existing = this.byKey(o.key);
    if (existing && ['running', 'proposed'].includes(existing.status)) return existing;

    const autonomous = isAutonomous(o.surface);
    const id = internalId();
    const now = this.clock.now();
    const rollback = { variant: {}, note: 'default behaviour, no variant applied' };
    const record: ExperimentRecord = {
      id,
      key: o.key,
      surface: o.surface,
      problem: o.problem,
      evidence: o.evidence,
      hypothesis: o.hypothesis,
      change: o.change,
      risk: autonomous ? 'low' : 'high',
      design: `A/B on ${Math.round(audiencePct * 100)}% of anonymous sessions, reversible in one step.`,
      audiencePct: autonomous ? audiencePct : 0,
      metrics: o.metrics,
      variant: o.variant,
      status: autonomous ? 'running' : 'blocked',
      requiresHuman: !autonomous,
      result: null,
      decision: autonomous ? null : 'awaiting human approval: protected surface',
      rollbackState: rollback,
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO experiments (id, key, surface, problem, evidence, hypothesis, change, risk,
            design, audience_pct, metrics, variant, status, requires_human, result, decision,
            rollback_state, created_at, updated_at)
         VALUES (@id, @key, @surface, @problem, @evidence, @hypothesis, @change, @risk, @design,
            @audiencePct, @metrics, @variant, @status, @requiresHuman, NULL, @decision,
            @rollbackState, @createdAt, @updatedAt)`
      )
      .run({
        ...record,
        metrics: JSON.stringify(record.metrics),
        variant: JSON.stringify(record.variant),
        requiresHuman: record.requiresHuman ? 1 : 0,
        rollbackState: JSON.stringify(record.rollbackState)
      });

    this.log(id, autonomous ? 'proposed' : 'blocked', o.change, {
      surface: o.surface,
      risk: record.risk,
      audiencePct: record.audiencePct
    });
    return record;
  }

  /**
   * Deterministic assignment: the same anonymous bucket always sees the same
   * side of an experiment, and no state has to be stored per visitor.
   */
  assignmentFor(bucket: string): Record<string, unknown> {
    const running = this.running();
    const variant: Record<string, unknown> = {};
    for (const exp of running) {
      const h = crypto.createHash('sha256').update(exp.key).update(bucket).digest();
      const unit = h.readUInt32BE(0) / 0xffffffff;
      if (unit < exp.audiencePct) Object.assign(variant, exp.variant);
    }
    return variant;
  }

  running(): ExperimentRecord[] {
    return (this.db.prepare(`SELECT * FROM experiments WHERE status = 'running'`).all() as Record<string, unknown>[])
      .map(toExperiment);
  }

  all(): ExperimentRecord[] {
    return (
      this.db.prepare(`SELECT * FROM experiments ORDER BY created_at DESC`).all() as Record<string, unknown>[]
    ).map(toExperiment);
  }

  byKey(key: string): ExperimentRecord | null {
    const row = this.db.prepare(`SELECT * FROM experiments WHERE key = ?`).get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? toExperiment(row) : null;
  }

  /** Record a measurement and a keep / modify / roll back decision. */
  decide(
    id: string,
    decision: 'kept' | 'modified' | 'rolled_back',
    result: string,
    note = ''
  ): void {
    const now = this.clock.now();
    this.db
      .prepare(`UPDATE experiments SET status = ?, decision = ?, result = ?, updated_at = ? WHERE id = ?`)
      .run(decision, decision, result, now, id);
    this.log(id, 'decided', `${decision}: ${result}`, { note });
  }

  /** Approve a blocked, protected-surface proposal. Only a human calls this. */
  humanApprove(id: string, approver: string, audiencePct = 0.1): void {
    const exp = this.all().find((e) => e.id === id);
    if (!exp) return;
    if (!exp.requiresHuman) return;
    this.db
      .prepare(
        `UPDATE experiments SET status = 'running', audience_pct = ?, decision = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(audiencePct, `approved by ${approver}`, this.clock.now(), id);
    this.log(id, 'human_approved', `approved by ${approver}`, { audiencePct });
  }

  log(
    experimentId: string | null,
    phase: string,
    note: string,
    payload: Record<string, unknown> = {}
  ): void {
    this.db
      .prepare(
        `INSERT INTO evolution_log (id, experiment_id, phase, note, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(internalId(), experimentId, phase, note, JSON.stringify(payload), this.clock.now());
  }

  /** The full "why did this change" record. */
  history(limit = 200) {
    return this.db
      .prepare(
        `SELECT l.created_at, l.phase, l.note, l.payload, e.key, e.surface, e.risk, e.status
         FROM evolution_log l LEFT JOIN experiments e ON e.id = l.experiment_id
         ORDER BY l.created_at DESC LIMIT ?`
      )
      .all(limit);
  }

  /** One pass of the loop. Safe to run on a timer. */
  tick(): { observed: number; proposed: number } {
    const observations = this.observe();
    let proposed = 0;
    for (const o of observations) {
      const before = this.byKey(o.key);
      this.propose(o);
      if (!before) proposed++;
    }
    return { observed: observations.length, proposed };
  }
}

function toExperiment(r: Record<string, unknown>): ExperimentRecord {
  return {
    id: r.id as string,
    key: r.key as string,
    surface: r.surface as string,
    problem: r.problem as string,
    evidence: r.evidence as string,
    hypothesis: r.hypothesis as string,
    change: r.change as string,
    risk: r.risk as ExperimentRecord['risk'],
    design: r.design as string,
    audiencePct: r.audience_pct as number,
    metrics: JSON.parse((r.metrics as string) || '[]'),
    variant: JSON.parse((r.variant as string) || '{}'),
    status: r.status as string,
    requiresHuman: !!r.requires_human,
    result: (r.result as string) ?? null,
    decision: (r.decision as string) ?? null,
    rollbackState: JSON.parse((r.rollback_state as string) || '{}'),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  };
}
