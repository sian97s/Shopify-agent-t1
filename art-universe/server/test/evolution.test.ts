import { afterEach, describe, expect, it } from 'vitest';
import { isAutonomous, LOW_RISK_SURFACES, PROTECTED_SURFACES } from '../src/domain/experiments/index.js';
import { AnalyticsService } from '../src/domain/analytics/index.js';
import { makeHarness, type TestHarness } from './helpers.js';

let harness: TestHarness | null = null;
afterEach(() => {
  harness?.cleanup();
  harness = null;
});

const observation = (surface: string) => ({
  key: `test-${surface}`,
  surface: surface as never,
  problem: 'something looks wrong',
  evidence: 'aggregate evidence',
  severity: 0.5,
  hypothesis: 'a hypothesis',
  change: 'a small change',
  variant: { spacing: 1.2 },
  metrics: ['metric']
});

describe('autonomy boundaries', () => {
  it('separates the surfaces autonomy may touch from the ones it may not', () => {
    for (const surface of LOW_RISK_SURFACES) expect(isAutonomous(surface)).toBe(true);
    for (const surface of PROTECTED_SURFACES) expect(isAutonomous(surface)).toBe(false);
  });

  it('runs a low-risk experiment on a small share of anonymous sessions', () => {
    harness = makeHarness();
    const exp = harness.ctx.evolution.propose(observation('spacing'), 0.15);
    expect(exp.status).toBe('running');
    expect(exp.risk).toBe('low');
    expect(exp.audiencePct).toBe(0.15);
    expect(exp.requiresHuman).toBe(false);
  });

  it('blocks anything touching a protected surface until a human approves it', () => {
    harness = makeHarness();
    for (const surface of PROTECTED_SURFACES) {
      const exp = harness.ctx.evolution.propose(observation(surface));
      expect(exp.status).toBe('blocked');
      expect(exp.requiresHuman).toBe(true);
      expect(exp.audiencePct).toBe(0);
      // Blocked proposals reach nobody.
      expect(harness.ctx.evolution.running().some((e) => e.id === exp.id)).toBe(false);
    }
  });

  it('only starts a protected experiment through explicit human approval', () => {
    harness = makeHarness();
    const exp = harness.ctx.evolution.propose(observation('content_safety'));
    harness.ctx.evolution.humanApprove(exp.id, 'a person', 0.05);
    const running = harness.ctx.evolution.running();
    expect(running.map((e) => e.id)).toContain(exp.id);
    expect(running[0].decision).toContain('approved by a person');
  });

  it('assigns variants deterministically, with no per-visitor state', () => {
    harness = makeHarness();
    harness.ctx.evolution.propose(observation('spacing'), 1);
    const a = harness.ctx.evolution.assignmentFor('bucket-one');
    const b = harness.ctx.evolution.assignmentFor('bucket-one');
    expect(a).toEqual(b);
    expect(a).toEqual({ spacing: 1.2 });
  });

  it('can always explain why a change happened, and how to undo it', () => {
    harness = makeHarness();
    const exp = harness.ctx.evolution.propose(observation('motion_speed'));
    harness.ctx.evolution.decide(exp.id, 'rolled_back', 'no measurable improvement');
    const log = harness.ctx.evolution.history();
    const phases = log.map((l) => (l as { phase: string }).phase);
    expect(phases).toContain('proposed');
    expect(phases).toContain('decided');
    const stored = harness.ctx.evolution.all().find((e) => e.id === exp.id)!;
    expect(stored.status).toBe('rolled_back');
    expect(stored.problem).toBeTruthy();
    expect(stored.evidence).toBeTruthy();
    expect(stored.hypothesis).toBeTruthy();
    expect(stored.rollbackState).toBeDefined();
  });
});

describe('anonymous analytics', () => {
  it('accepts only known events', () => {
    harness = makeHarness();
    expect(harness.ctx.analytics.record('search_submitted', {}, 'visitor')).toBe(true);
    expect(harness.ctx.analytics.record('exfiltrate_everything', {}, 'visitor')).toBe(false);
  });

  it('drops free text, keeping only numbers, booleans and short enums', () => {
    harness = makeHarness();
    harness.ctx.analytics.record(
      'search_submitted',
      { length: 12.3456, worked: true, kind: 'visual', note: 'my email is a@b.com and I live at…' },
      'visitor'
    );
    const row = harness.ctx.db.prepare('SELECT props FROM analytics_events').get() as { props: string };
    const props = JSON.parse(row.props);
    expect(props).toEqual({ length: 12.346, worked: true, kind: 'visual' });
    expect(row.props).not.toContain('@');
  });

  it('buckets by day, so a bucket cannot follow anyone', () => {
    const monday = AnalyticsService.bucketFor('visitor', '2026-01-05');
    const tuesday = AnalyticsService.bucketFor('visitor', '2026-01-06');
    expect(monday).not.toBe(tuesday);
    expect(monday).not.toContain('visitor');
  });

  it('prunes raw events past the retention window', () => {
    harness = makeHarness();
    harness.ctx.analytics.record('universe_opened', {}, 'visitor');
    harness.clock.advance(40 * 86400_000);
    harness.ctx.analytics.record('universe_opened', {}, 'visitor');
    expect(harness.ctx.analytics.prune(30)).toBe(1);
    const { n } = harness.ctx.db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get() as { n: number };
    expect(n).toBe(1);
  });
});
