import type { Db } from '../../infra/db.js';
import { distanceToCosine, toVectorBlob } from '../../infra/db.js';
import type { UniverseEdge } from '../../../../shared/types.js';

export type Facet = 'concept' | 'colour' | 'composition' | 'response';

export interface Neighbour {
  id: string;
  strength: number;
  facet: Facet;
}

/**
 * Relationships are what make the universe read as constellations rather than
 * a grid. Two kinds exist and must look different (§5):
 *  - `similarity`: found by the AI, quiet and thin
 *  - `response`: a human answered this artwork with art, and that is louder
 */
export class RelationshipService {
  constructor(private db: Db, private maxPerArtwork = 6) {}

  private knn(
    table: 'vec_semantic' | 'vec_visual',
    embedding: Float32Array,
    k: number,
    excludeId: string
  ): { id: string; score: number }[] {
    const rows = this.db
      .prepare(
        `SELECT artwork_id AS id, distance FROM ${table}
         WHERE embedding MATCH ? AND k = ? AND visibility = 'universe'`
      )
      .all(toVectorBlob(embedding), k) as { id: string; distance: number }[];
    return rows
      .filter((r) => r.id !== excludeId)
      .map((r) => ({ id: r.id, score: distanceToCosine(r.distance) }));
  }

  /**
   * Discover and persist an artwork's relationships. Called once, when a piece
   * enters the universe, and again for the pieces it now relates to.
   */
  computeFor(
    artworkId: string,
    semantic: Float32Array,
    visual: Float32Array,
    respondsTo: string | null
  ): Neighbour[] {
    const now = Date.now();
    const bySemantics = this.knn('vec_semantic', semantic, this.maxPerArtwork * 3, artworkId);
    const byVisual = this.knn('vec_visual', visual, this.maxPerArtwork * 3, artworkId);

    const merged = new Map<string, { concept: number; colour: number }>();
    for (const { id, score } of bySemantics) {
      merged.set(id, { concept: score, colour: merged.get(id)?.colour ?? 0 });
    }
    for (const { id, score } of byVisual) {
      const cur = merged.get(id) ?? { concept: 0, colour: 0 };
      cur.colour = score;
      merged.set(id, cur);
    }

    const scored: Neighbour[] = [...merged]
      .map(([id, s]) => {
        const strength = Math.max(s.concept, s.colour * 0.92);
        const facet: Facet =
          s.concept >= s.colour ? 'concept' : s.colour > 0.9 ? 'colour' : 'composition';
        return { id, strength, facet };
      })
      // Keep lines few and meaningful: a weak line is visual noise.
      .filter((n) => n.strength > 0.45)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, this.maxPerArtwork);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM relationships WHERE a_id = ? AND kind = 'similarity'`)
        .run(artworkId);
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO relationships (a_id, b_id, kind, strength, facet, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const n of scored) stmt.run(artworkId, n.id, 'similarity', n.strength, n.facet, now);
      if (respondsTo) {
        stmt.run(respondsTo, artworkId, 'response', 1, 'response', now);
      }
    });
    tx();
    return scored;
  }

  /** Edges among a given visible set, deduplicated and capped for legibility. */
  edgesFor(ids: string[], refByid: Map<string, string>, perNode = 3): UniverseEdge[] {
    if (ids.length < 2) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT a_id, b_id, kind, strength FROM relationships
         WHERE a_id IN (${placeholders}) AND b_id IN (${placeholders})
         ORDER BY kind DESC, strength DESC`
      )
      .all(...ids, ...ids) as { a_id: string; b_id: string; kind: string; strength: number }[];

    const seen = new Set<string>();
    const degree = new Map<string, number>();
    const edges: UniverseEdge[] = [];
    for (const r of rows) {
      const a = refByid.get(r.a_id);
      const b = refByid.get(r.b_id);
      if (!a || !b || a === b) continue;
      const key = [a, b].sort().join('~') + r.kind;
      if (seen.has(key)) continue;
      const da = degree.get(a) ?? 0;
      const db = degree.get(b) ?? 0;
      // Responses always draw; similarity lines yield to keep the sky clean.
      if (r.kind === 'similarity' && (da >= perNode || db >= perNode)) continue;
      seen.add(key);
      degree.set(a, da + 1);
      degree.set(b, db + 1);
      edges.push({
        a,
        b,
        kind: r.kind === 'response' ? 'response' : 'similarity',
        strength: r.strength
      });
    }
    return edges;
  }

  neighbours(artworkId: string, limit = 12): Neighbour[] {
    const rows = this.db
      .prepare(
        `SELECT b_id AS id, strength, facet, kind FROM relationships WHERE a_id = ?
         UNION
         SELECT a_id AS id, strength, facet, kind FROM relationships WHERE b_id = ?
         ORDER BY strength DESC LIMIT ?`
      )
      .all(artworkId, artworkId, limit) as
      { id: string; strength: number; facet: Facet; kind: string }[];
    return rows.map((r) => ({
      id: r.id,
      strength: r.strength,
      facet: r.kind === 'response' ? 'response' : r.facet
    }));
  }
}
