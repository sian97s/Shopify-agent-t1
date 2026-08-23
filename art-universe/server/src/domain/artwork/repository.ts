import type { Db } from '../../infra/db.js';
import { toVectorBlob } from '../../infra/db.js';
import type { ArtworkRecord, NewArtwork } from './types.js';
import type { Visibility } from '../../../../shared/types.js';

type Row = Record<string, unknown>;

const toRecord = (r: Row): ArtworkRecord => ({
  id: r.id as string,
  publicRef: r.public_ref as string,
  artKeyId: (r.art_key_id as string) ?? null,
  visibility: r.visibility as Visibility,
  title: (r.title as string) ?? null,
  titleSource: (r.title_source as ArtworkRecord['titleSource']) ?? null,
  status: r.status as ArtworkRecord['status'],
  width: r.width as number,
  height: r.height as number,
  palette: JSON.parse((r.palette as string) || '[]'),
  caption: (r.caption as string) ?? null,
  tags: JSON.parse((r.tags as string) || '[]'),
  mood: (r.mood as string) ?? null,
  style: (r.style as string) ?? null,
  medium: (r.medium as string) ?? null,
  subject: (r.subject as string) ?? null,
  storageKey: r.storage_key as string,
  x: r.x as number,
  y: r.y as number,
  gravity: r.gravity as number,
  gravityAt: r.gravity_at as number,
  respondsTo: (r.responds_to as string) ?? null,
  seeded: !!r.seeded,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
});

export class ArtworkRepository {
  constructor(private db: Db) {}

  insert(a: NewArtwork): ArtworkRecord {
    this.db
      .prepare(
        `INSERT INTO artworks (id, public_ref, art_key_id, visibility, title, title_source,
           status, width, height, palette, caption, tags, mood, style, medium, subject,
           storage_key, x, y, gravity, gravity_at, responds_to, seeded, created_at, updated_at)
         VALUES (@id, @publicRef, @artKeyId, @visibility, @title, @titleSource,
           'published', @width, @height, @palette, @caption, @tags, @mood, @style, @medium,
           @subject, @storageKey, @x, @y, 0, @createdAt, @respondsTo, @seeded, @createdAt,
           @createdAt)`
      )
      .run({
        ...a,
        palette: JSON.stringify(a.palette),
        tags: JSON.stringify(a.tags),
        seeded: a.seeded ? 1 : 0
      });
    return this.byId(a.id)!;
  }

  byId(id: string): ArtworkRecord | null {
    const row = this.db.prepare(`SELECT * FROM artworks WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  byRef(ref: string): ArtworkRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM artworks WHERE public_ref = ?`)
      .get(ref.toUpperCase()) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  byIds(ids: string[]): ArtworkRecord[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM artworks WHERE id IN (${placeholders})`)
      .all(...ids) as Row[];
    const byId = new Map(rows.map((r) => [r.id as string, toRecord(r)]));
    return ids.map((id) => byId.get(id)).filter((a): a is ArtworkRecord => !!a);
  }

  /** Everything publicly visible. Callers page or sample; the universe never sends all of it. */
  live(): ArtworkRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM artworks WHERE status = 'published' AND visibility = 'universe'`)
        .all() as Row[]
    ).map(toRecord);
  }

  ownedBy(artKeyId: string): ArtworkRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM artworks WHERE art_key_id = ? AND status != 'removed'
           ORDER BY created_at DESC`
        )
        .all(artKeyId) as Row[]
    ).map(toRecord);
  }

  countLive(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM artworks WHERE status = 'published' AND visibility = 'universe'`
        )
        .get() as { n: number }
    ).n;
  }

  /** Viewport query with a hard cap: the renderer never receives the whole universe. */
  inViewport(
    box: { minX: number; minY: number; maxX: number; maxY: number },
    limit: number
  ): ArtworkRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM artworks
           WHERE status = 'published' AND visibility = 'universe'
             AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?
           ORDER BY gravity DESC, created_at DESC
           LIMIT ?`
        )
        .all(box.minX, box.maxX, box.minY, box.maxY, limit) as Row[]
    ).map(toRecord);
  }

  responsesTo(artworkId: string): ArtworkRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM artworks WHERE responds_to = ? AND status = 'published'
             AND visibility = 'universe'`
        )
        .all(artworkId) as Row[]
    ).map(toRecord);
  }

  setTitle(id: string, title: string | null, source: 'creator' | 'suggested' | null) {
    this.db
      .prepare(`UPDATE artworks SET title = ?, title_source = ?, updated_at = ? WHERE id = ?`)
      .run(title, source, Date.now(), id);
  }

  setVisibility(id: string, visibility: Visibility) {
    this.db
      .prepare(`UPDATE artworks SET visibility = ?, updated_at = ? WHERE id = ?`)
      .run(visibility, Date.now(), id);
    for (const table of ['vec_semantic', 'vec_visual']) {
      // visibility is a partition key, so the vector row is rewritten.
      const vec = this.db
        .prepare(`SELECT embedding FROM ${table} WHERE artwork_id = ?`)
        .get(id) as { embedding: Buffer } | undefined;
      if (!vec) continue;
      this.db.prepare(`DELETE FROM ${table} WHERE artwork_id = ?`).run(id);
      this.db
        .prepare(`INSERT INTO ${table} (artwork_id, visibility, embedding) VALUES (?, ?, ?)`)
        .run(id, visibility, vec.embedding);
    }
  }

  setStatus(id: string, status: ArtworkRecord['status']) {
    this.db
      .prepare(`UPDATE artworks SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
  }

  setPosition(id: string, x: number, y: number) {
    this.db.prepare(`UPDATE artworks SET x = ?, y = ? WHERE id = ?`).run(x, y, id);
  }

  saveEmbeddings(
    id: string,
    visibility: Visibility,
    semantic: Float32Array,
    visual: Float32Array
  ) {
    const write = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM vec_semantic WHERE artwork_id = ?`).run(id);
      this.db.prepare(`DELETE FROM vec_visual WHERE artwork_id = ?`).run(id);
      this.db
        .prepare(`INSERT INTO vec_semantic (artwork_id, visibility, embedding) VALUES (?, ?, ?)`)
        .run(id, visibility, toVectorBlob(semantic));
      this.db
        .prepare(`INSERT INTO vec_visual (artwork_id, visibility, embedding) VALUES (?, ?, ?)`)
        .run(id, visibility, toVectorBlob(visual));
    });
    write();
  }

  embedding(table: 'vec_semantic' | 'vec_visual', id: string): Float32Array | null {
    const row = this.db
      .prepare(`SELECT embedding FROM ${table} WHERE artwork_id = ?`)
      .get(id) as { embedding: Buffer } | undefined;
    if (!row) return null;
    const buf = row.embedding;
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }

  remove(id: string) {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM vec_semantic WHERE artwork_id = ?`).run(id);
      this.db.prepare(`DELETE FROM vec_visual WHERE artwork_id = ?`).run(id);
      this.db.prepare(`UPDATE artworks SET status = 'removed', updated_at = ? WHERE id = ?`)
        .run(Date.now(), id);
    });
    tx();
  }
}
