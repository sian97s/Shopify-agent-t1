import type { Db } from '../../infra/db.js';

export class NotOwnerError extends Error {
  constructor() {
    super('not the owner');
    this.name = 'NotOwnerError';
  }
}

/**
 * Anonymous ownership: an Art Key owns many artworks; an artwork belongs to at
 * most one Art Key. Every mutation of an artwork goes through this check.
 */
export class OwnershipService {
  constructor(private db: Db) {}

  ownerOf(artworkId: string): string | null {
    const row = this.db
      .prepare(`SELECT art_key_id FROM artworks WHERE id = ?`)
      .get(artworkId) as { art_key_id: string | null } | undefined;
    return row?.art_key_id ?? null;
  }

  owns(artKeyId: string | null, artworkId: string): boolean {
    if (!artKeyId) return false;
    return this.ownerOf(artworkId) === artKeyId;
  }

  /** Throws unless the given key owns the artwork. */
  assertOwner(artKeyId: string | null, artworkId: string): void {
    if (!this.owns(artKeyId, artworkId)) throw new NotOwnerError();
  }

  /** Artworks a key owns, newest first. Private pieces included. */
  artworkIdsFor(artKeyId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM artworks
           WHERE art_key_id = ? AND status != 'removed'
           ORDER BY created_at DESC`
        )
        .all(artKeyId) as { id: string }[]
    ).map((r) => r.id);
  }

  /** Whether this key has ever published anything (drives first-publish key issue). */
  hasPublished(artKeyId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM artworks WHERE art_key_id = ? LIMIT 1`)
      .get(artKeyId);
  }
}
