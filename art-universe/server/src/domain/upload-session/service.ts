import crypto from 'node:crypto';
import type { Db } from '../../infra/db.js';
import type { Clock } from '../../infra/clock.js';
import { systemClock } from '../../infra/clock.js';
import { internalId, opaqueToken } from '../../infra/ids.js';
import type { ModerationState, PublicRejectionReason, Visibility } from '../../../../shared/types.js';
import { isTerminal, transition } from '../moderation/state-machine.js';

export interface UploadSession {
  id: string;
  artKeyId: string | null;
  visibility: Visibility;
  state: ModerationState;
  reason: PublicRejectionReason | null;
  artworkId: string | null;
  respondsTo: string | null;
  title: string | null;
  suggestedTitle: string | null;
  createdAt: number;
  expiresAt: number;
  lastHeartbeatAt: number;
  connections: number;
  cancelReason: string | null;
}

export class SessionNotActiveError extends Error {
  constructor(public state: ModerationState) {
    super(`upload session is ${state}`);
    this.name = 'SessionNotActiveError';
  }
}

export class SessionAuthError extends Error {
  constructor() {
    super('invalid upload session token');
    this.name = 'SessionAuthError';
  }
}

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('base64url');

const toSession = (r: Record<string, unknown>): UploadSession => ({
  id: r.id as string,
  artKeyId: (r.art_key_id as string) ?? null,
  visibility: r.visibility as Visibility,
  state: r.state as ModerationState,
  reason: (r.reason as PublicRejectionReason) ?? null,
  artworkId: (r.artwork_id as string) ?? null,
  respondsTo: (r.responds_to as string) ?? null,
  title: (r.title as string) ?? null,
  suggestedTitle: (r.suggested_title as string) ?? null,
  createdAt: r.created_at as number,
  expiresAt: r.expires_at as number,
  lastHeartbeatAt: r.last_heartbeat_at as number,
  connections: r.connections as number,
  cancelReason: (r.cancel_reason as string) ?? null
});

export interface UploadSessionOptions {
  ttlMs: number;
  /**
   * How long a session survives without a heartbeat. Phones suspend tabs, so
   * this window must forgive normal app-switching and only cancel genuine
   * abandonment (§8 "Mobile grace").
   */
  graceMs: number;
}

/**
 * The upload session is the thing that keeps a submission alive. If it dies,
 * the submission dies with it — there is no queue, and nothing can appear in
 * the universe after the creator has left.
 */
export class UploadSessionService {
  private listeners = new Set<(session: UploadSession) => void>();

  constructor(
    private db: Db,
    private options: UploadSessionOptions,
    private clock: Clock = systemClock
  ) {}

  onChange(fn: (session: UploadSession) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(session: UploadSession) {
    for (const fn of this.listeners) fn(session);
  }

  create(input: {
    artKeyId: string | null;
    visibility: Visibility;
    respondsTo?: string | null;
    title?: string | null;
  }): { session: UploadSession; token: string } {
    const now = this.clock.now();
    const id = internalId();
    const token = opaqueToken();
    this.db
      .prepare(
        `INSERT INTO upload_sessions
           (id, token_hash, art_key_id, visibility, state, responds_to, title,
            created_at, expires_at, last_heartbeat_at, connections)
         VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, 0)`
      )
      .run(
        id, hashToken(token), input.artKeyId, input.visibility,
        input.respondsTo ?? null, input.title ?? null,
        now, now + this.options.ttlMs, now
      );
    const session = this.get(id)!;
    this.emit(session);
    return { session, token };
  }

  get(id: string): UploadSession | null {
    const row = this.db.prepare(`SELECT * FROM upload_sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toSession(row) : null;
  }

  /** Fetch a session, verifying the caller holds its token (constant-time). */
  authorise(id: string, token: string): UploadSession {
    const row = this.db.prepare(`SELECT * FROM upload_sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new SessionAuthError();
    const expected = Buffer.from(row.token_hash as string);
    const actual = Buffer.from(hashToken(token));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      throw new SessionAuthError();
    }
    return toSession(row);
  }

  assertActive(session: UploadSession): UploadSession {
    if (isTerminal(session.state)) throw new SessionNotActiveError(session.state);
    if (this.isAbandoned(session)) {
      const cancelled = this.cancel(session.id, 'abandoned');
      throw new SessionNotActiveError(cancelled?.state ?? 'cancelled');
    }
    return session;
  }

  isAbandoned(session: UploadSession, now = this.clock.now()): boolean {
    if (isTerminal(session.state)) return false;
    if (now > session.expiresAt) return true;
    return now - session.lastHeartbeatAt > this.options.graceMs;
  }

  heartbeat(id: string): UploadSession | null {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE upload_sessions SET last_heartbeat_at = ?
         WHERE id = ? AND state IN ('processing','needs_review')`
      )
      .run(now, id);
    return this.get(id);
  }

  connectionOpened(id: string) {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE upload_sessions SET connections = connections + 1, last_heartbeat_at = ?
         WHERE id = ?`
      )
      .run(now, id);
  }

  connectionClosed(id: string) {
    // The socket dropping is not itself abandonment: the grace window decides.
    this.db
      .prepare(
        `UPDATE upload_sessions SET connections = MAX(0, connections - 1) WHERE id = ?`
      )
      .run(id);
  }

  /** Move a session to a new moderation state, enforcing the state machine. */
  settle(
    id: string,
    to: ModerationState,
    extra: {
      reason?: PublicRejectionReason | null;
      artworkId?: string | null;
      suggestedTitle?: string | null;
      cancelReason?: string | null;
    } = {}
  ): UploadSession {
    const current = this.get(id);
    if (!current) throw new Error(`unknown upload session ${id}`);
    const next = transition(current.state, to);
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE upload_sessions
         SET state = ?, reason = COALESCE(?, reason), artwork_id = COALESCE(?, artwork_id),
             suggested_title = COALESCE(?, suggested_title),
             cancel_reason = COALESCE(?, cancel_reason),
             finished_at = CASE WHEN ? IN ('approved','rejected','cancelled') THEN ? ELSE finished_at END
         WHERE id = ?`
      )
      .run(
        next, extra.reason ?? null, extra.artworkId ?? null, extra.suggestedTitle ?? null,
        extra.cancelReason ?? null, next, now, id
      );
    const updated = this.get(id)!;
    this.emit(updated);
    return updated;
  }

  cancel(id: string, reason: string): UploadSession | null {
    const current = this.get(id);
    if (!current || isTerminal(current.state)) return current;
    return this.settle(id, 'cancelled', { cancelReason: reason });
  }

  setTitle(id: string, title: string | null) {
    this.db.prepare(`UPDATE upload_sessions SET title = ? WHERE id = ?`).run(title, id);
  }

  setVisibility(id: string, visibility: Visibility) {
    this.db.prepare(`UPDATE upload_sessions SET visibility = ? WHERE id = ?`).run(visibility, id);
  }

  /** Sessions a human moderator could still act on — live ones only. */
  liveAwaitingReview(): UploadSession[] {
    const now = this.clock.now();
    return (
      this.db
        .prepare(`SELECT * FROM upload_sessions WHERE state = 'needs_review'`)
        .all() as Record<string, unknown>[]
    )
      .map(toSession)
      .filter((s) => !this.isAbandoned(s, now));
  }

  /**
   * A session cannot survive a restart: the creator is not there, and nothing
   * may appear in the universe after they have gone. Called at boot.
   */
  cancelAllLive(reason: string): number {
    const rows = this.db
      .prepare(`SELECT id FROM upload_sessions WHERE state IN ('processing','needs_review')`)
      .all() as { id: string }[];
    for (const r of rows) this.cancel(r.id, reason);
    return rows.length;
  }

  /**
   * Cancel everything that expired or was abandoned. Runs on a timer and at
   * boot, because a session cannot have survived a restart.
   */
  reap(now = this.clock.now()): UploadSession[] {
    const rows = (
      this.db
        .prepare(`SELECT * FROM upload_sessions WHERE state IN ('processing','needs_review')`)
        .all() as Record<string, unknown>[]
    ).map(toSession);
    const cancelled: UploadSession[] = [];
    for (const s of rows) {
      if (!this.isAbandoned(s, now)) continue;
      const reason = now > s.expiresAt ? 'expired' : 'abandoned';
      const updated = this.cancel(s.id, reason);
      if (updated) cancelled.push(updated);
    }
    return cancelled;
  }
}
