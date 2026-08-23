import crypto from 'node:crypto';
import type { Db } from '../../infra/db.js';
import type { ReactionKind } from '../../../../shared/types.js';
import type { GravityService } from '../gravity/index.js';

/**
 * Reactions are deliberately constrained (§12): two of them, never counted in
 * public, and never attached to an identity. The actor hash exists only to
 * stop one visitor reacting a thousand times to the same piece.
 */
export class ReactionService {
  constructor(private db: Db, private gravity: GravityService) {}

  /** A per-artwork, per-visitor hash. Not reversible to a person or a session. */
  static actorHash(anonymousToken: string, artworkId: string): string {
    return crypto
      .createHash('sha256')
      .update(anonymousToken)
      .update('|')
      .update(artworkId)
      .digest('base64url')
      .slice(0, 22);
  }

  react(artworkId: string, anonymousToken: string, kind: ReactionKind): boolean {
    const actor = ReactionService.actorHash(anonymousToken, artworkId);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO reactions (id, artwork_id, actor_hash, kind, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), artworkId, actor, kind, Date.now());
    if (result.changes === 0) return false;
    this.gravity.record(artworkId, kind === 'inspired' ? 'inspired' : 'appreciate');
    return true;
  }

  /** What this visitor has already expressed, so the control can reflect it. */
  mine(artworkId: string, anonymousToken: string): ReactionKind[] {
    const actor = ReactionService.actorHash(anonymousToken, artworkId);
    return (
      this.db
        .prepare(`SELECT kind FROM reactions WHERE artwork_id = ? AND actor_hash = ?`)
        .all(artworkId, actor) as { kind: ReactionKind }[]
    ).map((r) => r.kind);
  }
}
