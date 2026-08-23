import type { ArtworkRecord } from '../artwork/types.js';
import type { GravityService } from '../gravity/index.js';
import type { Clock } from '../../infra/clock.js';
import { systemClock } from '../../infra/clock.js';

export interface Candidate {
  artwork: ArtworkRecord;
  /** 0..1 similarity to whatever is organising the universe right now. */
  relevance: number;
}

export interface DiscoveryContext {
  /** True for "show me something completely different". */
  diversify?: boolean;
  /** Pieces already on screen, so exploration keeps moving. */
  seen?: Set<string>;
  /** Deterministic seed, so the same search twice does not reshuffle the sky. */
  seed?: string;
}

const hashUnit = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
};

/**
 * Discovery = relevance + freshness + meaningful attention + diversity +
 * randomness + under-explored work + visual similarity + exploration context.
 *
 * The weights may change; the philosophy may not. Popularity alone never ranks
 * anything, and a deliberate under-explored bonus keeps new work in play.
 */
export const DISCOVERY_WEIGHTS = {
  relevance: 1.0,
  freshness: 0.28,
  attention: 0.22,
  underExplored: 0.2,
  randomness: 0.14,
  diversityPenalty: 0.35
} as const;

export class DiscoveryService {
  constructor(
    private gravity: GravityService,
    private clock: Clock = systemClock
  ) {}

  rank(candidates: Candidate[], ctx: DiscoveryContext = {}): Candidate[] {
    const now = this.clock.now();
    const seed = ctx.seed ?? 'universe';
    const week = 7 * 24 * 3600_000;

    const scored = candidates.map((c) => {
      const a = c.artwork;
      const ageDays = (now - a.createdAt) / (24 * 3600_000);
      const freshness = Math.exp(-ageDays / 21);
      const attention = this.gravity.presentation(a.gravity, a.gravityAt, now);
      // Under-explored: young work that has had little attention gets a lift,
      // so the universe never settles into a permanent hierarchy.
      const underExplored = attention < 0.1 && now - a.createdAt < 8 * week ? 1 : 0;
      const randomness = hashUnit(seed + a.id);
      const relevance = ctx.diversify ? 1 - c.relevance : c.relevance;

      let score =
        DISCOVERY_WEIGHTS.relevance * relevance +
        DISCOVERY_WEIGHTS.freshness * freshness +
        DISCOVERY_WEIGHTS.attention * attention +
        DISCOVERY_WEIGHTS.underExplored * underExplored +
        DISCOVERY_WEIGHTS.randomness * randomness;

      // Diversity: keep the same corner of the universe from filling the view.
      if (ctx.seen?.has(a.id)) score -= DISCOVERY_WEIGHTS.diversityPenalty;

      return { candidate: c, score, mood: a.mood ?? 'unknown' };
    });

    scored.sort((a, b) => b.score - a.score);

    // Spread moods: no more than a third of the front of the result may share one.
    const out: typeof scored = [];
    const moodCount = new Map<string, number>();
    const deferred: typeof scored = [];
    for (const s of scored) {
      const n = moodCount.get(s.mood) ?? 0;
      const cap = Math.max(3, Math.ceil(scored.length / 3));
      if (n >= cap) deferred.push(s);
      else {
        moodCount.set(s.mood, n + 1);
        out.push(s);
      }
    }
    return [...out, ...deferred].map((s) => s.candidate);
  }
}
