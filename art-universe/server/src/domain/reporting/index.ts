import crypto from 'node:crypto';
import type { Db } from '../../infra/db.js';

export const REPORT_REASONS = [
  'unsafe',
  'personal_information',
  'hateful',
  'spam',
  'not_my_art',
  'other'
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * Reporting is the one escape hatch in a product with no comments and no
 * messages, so it stays available on every public artwork — and stays quiet
 * until someone needs it.
 */
export class ReportingService {
  constructor(private db: Db, private autoHideThreshold = 3) {}

  report(artworkId: string, reason: ReportReason, anonymousToken: string): void {
    const actor = crypto
      .createHash('sha256')
      .update(anonymousToken)
      .update(artworkId)
      .digest('base64url')
      .slice(0, 22);
    this.db
      .prepare(
        `INSERT INTO reports (id, artwork_id, reason, actor_hash, created_at)
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM reports WHERE artwork_id = ? AND actor_hash = ?)`
      )
      .run(crypto.randomUUID(), artworkId, reason, actor, Date.now(), artworkId, actor);

    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM reports WHERE artwork_id = ? AND state = 'open'`)
      .get(artworkId) as { n: number };

    // Enough independent reports and the piece steps out of the universe until
    // a human looks. Withdrawn, not deleted: the creator's work is not lost.
    if (n >= this.autoHideThreshold) {
      this.db
        .prepare(`UPDATE artworks SET status = 'withdrawn', updated_at = ? WHERE id = ? AND status = 'published'`)
        .run(Date.now(), artworkId);
    }
  }

  open(limit = 100) {
    return this.db
      .prepare(
        `SELECT r.id, r.reason, r.created_at, a.public_ref, a.status, COUNT(*) OVER (PARTITION BY r.artwork_id) AS reports
         FROM reports r JOIN artworks a ON a.id = r.artwork_id
         WHERE r.state = 'open' ORDER BY r.created_at DESC LIMIT ?`
      )
      .all(limit);
  }

  resolve(reportId: string, action: 'actioned' | 'dismissed', removeArtwork: boolean) {
    const row = this.db.prepare(`SELECT artwork_id FROM reports WHERE id = ?`).get(reportId) as
      | { artwork_id: string }
      | undefined;
    if (!row) return;
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE reports SET state = ?, resolved_at = ? WHERE id = ?`)
        .run(action, Date.now(), reportId);
      if (removeArtwork) {
        this.db
          .prepare(`UPDATE artworks SET status = 'removed', updated_at = ? WHERE id = ?`)
          .run(Date.now(), row.artwork_id);
        this.db.prepare(`DELETE FROM vec_semantic WHERE artwork_id = ?`).run(row.artwork_id);
        this.db.prepare(`DELETE FROM vec_visual WHERE artwork_id = ?`).run(row.artwork_id);
      } else if (action === 'dismissed') {
        this.db
          .prepare(`UPDATE artworks SET status = 'published' WHERE id = ? AND status = 'withdrawn'`)
          .run(row.artwork_id);
      }
    });
    tx();
  }
}
