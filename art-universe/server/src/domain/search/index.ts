import type { Db } from '../../infra/db.js';
import { distanceToCosine, toVectorBlob } from '../../infra/db.js';
import { blend, embedQuery } from '../../services/ai/embeddings.js';
import { readIntent } from '../../services/ai/lexicon.js';
import type { ArtworkRepository } from '../artwork/repository.js';
import type { DiscoveryContext } from '../discovery/index.js';
import { DiscoveryService, type Candidate } from '../discovery/index.js';

export interface SearchResult {
  candidates: Candidate[];
  diversify: boolean;
  /** Centre of mass of the strongest results — where the camera should travel. */
  focus: { x: number; y: number } | null;
}

/**
 * Search never produces a page of results. It produces a new organising force:
 * a set of artworks with relevance scores that the universe reorganises around.
 */
export class SearchService {
  constructor(
    private db: Db,
    private artworks: ArtworkRepository,
    private discovery: DiscoveryService
  ) {}

  private knn(
    table: 'vec_semantic' | 'vec_visual',
    embedding: Float32Array,
    k: number
  ): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT artwork_id AS id, distance FROM ${table}
         WHERE embedding MATCH ? AND k = ? AND visibility = 'universe'`
      )
      .all(toVectorBlob(embedding), k) as { id: string; distance: number }[];
    return new Map(rows.map((r) => [r.id, distanceToCosine(r.distance)]));
  }

  /** Natural-language search. */
  byText(query: string, opts: { limit?: number; context?: DiscoveryContext } = {}): SearchResult {
    const limit = opts.limit ?? 90;
    const intent = readIntent(query);
    const vector = embedQuery(intent.cleaned);
    const hits = this.knn('vec_semantic', vector, Math.min(limit * 3, 400));

    const records = this.artworks.byIds([...hits.keys()]);
    const candidates: Candidate[] = records.map((artwork) => ({
      artwork,
      relevance: Math.max(0, hits.get(artwork.id) ?? 0)
    }));

    const ranked = this.discovery
      .rank(candidates, { ...opts.context, diversify: intent.diversify, seed: query })
      .slice(0, limit);

    return { candidates: ranked, diversify: intent.diversify, focus: focusOf(ranked) };
  }

  /**
   * "More like this": colour, composition and concept together, so the result
   * feels like the artwork's own neighbourhood rather than a tag match.
   */
  byArtwork(artworkId: string, opts: { limit?: number } = {}): SearchResult {
    const limit = opts.limit ?? 60;
    const semantic = this.artworks.embedding('vec_semantic', artworkId);
    const visual = this.artworks.embedding('vec_visual', artworkId);
    if (!semantic || !visual) return { candidates: [], diversify: false, focus: null };

    const bySemantic = this.knn('vec_semantic', semantic, limit * 3);
    const byVisual = this.knn('vec_visual', visual, limit * 3);

    const merged = new Map<string, number>();
    for (const [id, score] of bySemantic) merged.set(id, score * 0.6);
    for (const [id, score] of byVisual) merged.set(id, (merged.get(id) ?? 0) + score * 0.5);
    merged.delete(artworkId);

    const records = this.artworks.byIds([...merged.keys()]);
    const candidates: Candidate[] = records.map((artwork) => ({
      artwork,
      relevance: Math.min(1, merged.get(artwork.id) ?? 0)
    }));
    const ranked = this.discovery.rank(candidates, { seed: artworkId }).slice(0, limit);
    return { candidates: ranked, diversify: false, focus: focusOf(ranked) };
  }

  /** Blend of several artworks — used when exploring outward from a selection. */
  byArtworks(ids: string[], limit = 60): SearchResult {
    const vectors = ids
      .map((id) => this.artworks.embedding('vec_semantic', id))
      .filter((v): v is Float32Array => !!v)
      .map((vector) => ({ vector, weight: 1 }));
    if (!vectors.length) return { candidates: [], diversify: false, focus: null };
    const hits = this.knn('vec_semantic', blend(vectors), limit * 3);
    for (const id of ids) hits.delete(id);
    const records = this.artworks.byIds([...hits.keys()]);
    const ranked = this.discovery
      .rank(
        records.map((artwork) => ({ artwork, relevance: hits.get(artwork.id) ?? 0 })),
        { seed: ids.join(',') }
      )
      .slice(0, limit);
    return { candidates: ranked, diversify: false, focus: focusOf(ranked) };
  }
}

function focusOf(ranked: Candidate[]): { x: number; y: number } | null {
  const top = ranked.slice(0, 12);
  if (!top.length) return null;
  let x = 0;
  let y = 0;
  let w = 0;
  for (const c of top) {
    const weight = Math.max(0.05, c.relevance);
    x += c.artwork.x * weight;
    y += c.artwork.y * weight;
    w += weight;
  }
  return { x: x / w, y: y / w };
}
