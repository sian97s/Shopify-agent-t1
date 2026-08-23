import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../../infra/db.js';
import { internalId, publicRef } from '../../infra/ids.js';
import type { Clock } from '../../infra/clock.js';
import { systemClock } from '../../infra/clock.js';
import type { ObjectStorage } from '../../services/storage/index.js';
import type { ModerationState, UniverseNode } from '../../../../shared/types.js';
import { ArtworkRepository } from '../artwork/repository.js';
import { positionFor } from '../artwork/layout.js';
import { toNode } from '../artwork/present.js';
import { ArtKeyService } from '../artkey/service.js';
import { RelationshipService } from '../relationships/index.js';
import { GravityService } from '../gravity/index.js';
import { DERIVATIVES } from '../../services/images/processor.js';
import { UploadSessionService, type UploadSession } from '../upload-session/service.js';
import { ModerationPipeline, SubmissionCancelled, type PipelineOutcome } from './pipeline.js';

export interface IntakeResult {
  state: ModerationState;
  node?: UniverseNode;
  artKey?: string;
  suggestedTitle?: string | null;
}

/**
 * Orchestrates one submission from bytes to either a published artwork or
 * nothing at all. Everything it writes is conditional on the upload session
 * still being alive at the moment of writing.
 */
export class IntakeService {
  constructor(
    private db: Db,
    private deps: {
      sessions: UploadSessionService;
      pipeline: ModerationPipeline;
      artworks: ArtworkRepository;
      artKeys: ArtKeyService;
      relationships: RelationshipService;
      gravity: GravityService;
      storage: ObjectStorage;
      tmpDir: string;
      clock?: Clock;
    }
  ) {}

  private get clock(): Clock {
    return this.deps.clock ?? systemClock;
  }

  private tmpPath(sessionId: string) {
    return path.join(this.deps.tmpDir, `${sessionId}.bin`);
  }

  /** Runs moderation for a submission. Publishes only on approval. */
  async submit(
    session: UploadSession,
    file: Buffer,
    onStage?: (stage: string) => void
  ): Promise<IntakeResult> {
    const runId = internalId();
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO moderation_runs (id, session_id, state, checks, created_at, updated_at)
         VALUES (?, ?, 'processing', '[]', ?, ?)`
      )
      .run(runId, session.id, now, now);

    // Temporary processing copy: needed if a human has to look at it while the
    // creator waits. Removed the moment the session reaches a terminal state.
    await fs.mkdir(this.deps.tmpDir, { recursive: true });
    await fs.writeFile(this.tmpPath(session.id), file);

    const stillAlive = () => {
      const current = this.deps.sessions.get(session.id);
      return !!current && !this.deps.sessions.isAbandoned(current) && current.state !== 'cancelled';
    };

    let outcome: PipelineOutcome;
    try {
      outcome = await this.deps.pipeline.run(file, {
        visibility: session.visibility,
        stillAlive,
        onStage
      });
    } catch (err) {
      if (err instanceof SubmissionCancelled) {
        await this.discard(session.id, 'abandoned');
        // Cancel now rather than waiting for the reaper, so the creator's
        // client hears about it immediately and nothing is left in flight.
        this.deps.sessions.cancel(session.id, 'abandoned');
        this.finishRun(runId, 'cancelled', null, ['session ended during moderation']);
        return { state: 'cancelled' };
      }
      throw err;
    }

    this.finishRun(runId, outcome.decision, outcome.reason, outcome.notes, outcome.checks);

    if (outcome.decision === 'rejected') {
      await this.discard(session.id, 'rejected');
      this.deps.sessions.settle(session.id, 'rejected', { reason: outcome.reason });
      return { state: 'rejected' };
    }

    if (outcome.decision === 'needs_review') {
      this.deps.sessions.settle(session.id, 'needs_review', {
        suggestedTitle: outcome.analysis?.suggestedTitle ?? null
      });
      this.pending.set(session.id, outcome);
      return { state: 'needs_review', suggestedTitle: outcome.analysis?.suggestedTitle ?? null };
    }

    return this.publish(session.id, outcome);
  }

  /** Outcomes held in memory while a human decides and the creator waits. */
  private pending = new Map<string, PipelineOutcome>();

  /** A human moderator's decision on a live session. */
  async review(sessionId: string, approve: boolean, moderator: string): Promise<IntakeResult> {
    const session = this.deps.sessions.get(sessionId);
    if (!session || session.state !== 'needs_review') {
      return { state: session?.state ?? 'cancelled' };
    }
    if (this.deps.sessions.isAbandoned(session)) {
      await this.discard(sessionId, 'abandoned');
      this.deps.sessions.cancel(sessionId, 'abandoned');
      return { state: 'cancelled' };
    }
    this.db
      .prepare(
        `UPDATE moderation_runs SET reviewed_by = ?, state = ?, updated_at = ?
         WHERE session_id = ?`
      )
      .run(moderator, approve ? 'approved' : 'rejected', this.clock.now(), sessionId);

    if (!approve) {
      await this.discard(sessionId, 'rejected');
      this.deps.sessions.settle(sessionId, 'rejected', { reason: 'could_not_verify' });
      return { state: 'rejected' };
    }
    const outcome = this.pending.get(sessionId);
    if (!outcome) {
      // The server restarted; the submission cannot be revived after the fact.
      await this.discard(sessionId, 'lost');
      this.deps.sessions.cancel(sessionId, 'lost');
      return { state: 'cancelled' };
    }
    return this.publish(sessionId, outcome);
  }

  /**
   * Write the artwork into the universe. This is the only path that creates a
   * published artwork, and it re-checks liveness immediately before writing.
   */
  private async publish(sessionId: string, outcome: PipelineOutcome): Promise<IntakeResult> {
    const session = this.deps.sessions.get(sessionId);
    if (!session || this.deps.sessions.isAbandoned(session)) {
      await this.discard(sessionId, 'abandoned');
      this.deps.sessions.cancel(sessionId, 'abandoned');
      return { state: 'cancelled' };
    }
    const prepared = outcome.prepared!;
    const analysis = outcome.analysis!;

    // The Art Key is created only now — never before moderation succeeds.
    let artKeyId = session.artKeyId;
    let rawKey: string | undefined;
    if (!artKeyId) {
      const created = await this.deps.artKeys.create();
      artKeyId = created.id;
      rawKey = created.rawKey;
    }

    const id = internalId();
    let ref = publicRef();
    while (this.deps.artworks.byRef(ref)) ref = publicRef();
    const storageKey = `art/${ref}`;

    await this.deps.storage.put(`${storageKey}/master.webp`, prepared.master, 'image/webp');
    for (const d of DERIVATIVES) {
      await this.deps.storage.put(
        `${storageKey}/${d.name}.webp`,
        prepared.derivatives[d.name],
        'image/webp'
      );
    }

    const parent = session.respondsTo ? this.deps.artworks.byId(session.respondsTo) : null;
    const position = positionFor(outcome.semantic!, {
      jitterSeed: id,
      near: parent ? { x: parent.x, y: parent.y } : undefined
    });

    const title = session.title?.trim() || null;
    const record = this.deps.artworks.insert({
      id,
      publicRef: ref,
      artKeyId,
      visibility: session.visibility,
      title,
      titleSource: title ? 'creator' : null,
      width: prepared.width,
      height: prepared.height,
      palette: prepared.features.palette,
      caption: analysis.caption,
      tags: analysis.tags,
      mood: analysis.mood,
      style: analysis.style,
      medium: analysis.medium,
      subject: analysis.subject,
      storageKey,
      x: position.x,
      y: position.y,
      respondsTo: parent?.id ?? null,
      createdAt: this.clock.now()
    });

    this.deps.artworks.saveEmbeddings(id, record.visibility, outcome.semantic!, outcome.visual!);
    if (record.visibility === 'universe') {
      this.deps.relationships.computeFor(id, outcome.semantic!, outcome.visual!, record.respondsTo);
      if (record.respondsTo) {
        // A response is the strongest signal of meaningful attention there is.
        this.deps.gravity.record(record.respondsTo, 'response');
      }
    }

    await this.discard(sessionId, 'published');
    this.pending.delete(sessionId);
    this.deps.sessions.settle(sessionId, 'approved', {
      artworkId: id,
      suggestedTitle: analysis.suggestedTitle
    });

    return {
      state: 'approved',
      node: toNode(record, {
        storage: this.deps.storage,
        gravity: this.deps.gravity,
        refOf: (rid) => this.deps.artworks.byId(rid)?.publicRef ?? null
      }),
      artKey: rawKey,
      suggestedTitle: analysis.suggestedTitle
    };
  }

  /** Drop the temporary copy. Nothing survives a cancelled or rejected upload. */
  async discard(sessionId: string, _why: string) {
    this.pending.delete(sessionId);
    await fs.rm(this.tmpPath(sessionId), { force: true });
  }

  private finishRun(
    runId: string,
    state: string,
    reason: string | null,
    notes: string[],
    checks: unknown[] = []
  ) {
    this.db
      .prepare(
        `UPDATE moderation_runs SET state = ?, reason = ?, detail = ?, checks = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(state, reason, notes.join(' | '), JSON.stringify(checks), this.clock.now(), runId);
  }
}
