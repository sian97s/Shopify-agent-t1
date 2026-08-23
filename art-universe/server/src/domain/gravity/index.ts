import type { Db } from '../../infra/db.js';
import type { Clock } from '../../infra/clock.js';
import { systemClock } from '../../infra/clock.js';
import type { GravityBand, QualitativeSignal } from '../../../../shared/types.js';

/**
 * Meaningful-attention hierarchy (§13). An artistic response is worth an order
 * of magnitude more than a passive view, so gravity rewards inspiration rather
 * than attention harvesting.
 */
export const ATTENTION_WEIGHTS = {
  response: 1.0,
  inspired: 0.55,
  appreciate: 0.35,
  explore_related: 0.12,
  view: 0.02
} as const;

export type AttentionKind = keyof typeof ATTENTION_WEIGHTS;

/** Saturation constant: the curve flattens quickly so nobody becomes a giant node. */
const SATURATION = 7;

/**
 * Hard ceiling on presentation. Gravity is a matter of glow, and no amount of
 * attention may light an artwork all the way up — there is always headroom
 * left, so nothing ever reads as "this artist matters more".
 */
const CEILING = 0.9;

export class GravityService {
  constructor(
    private db: Db,
    private halfLifeMs: number,
    private clock: Clock = systemClock
  ) {}

  /** Decay an accumulator forward to `now`. Recent interaction outweighs lifetime totals. */
  decay(value: number, since: number, now = this.clock.now()): number {
    const elapsed = Math.max(0, now - since);
    return value * Math.pow(2, -elapsed / this.halfLifeMs);
  }

  record(artworkId: string, kind: AttentionKind): void {
    const now = this.clock.now();
    const row = this.db
      .prepare(`SELECT gravity, gravity_at FROM artworks WHERE id = ?`)
      .get(artworkId) as { gravity: number; gravity_at: number } | undefined;
    if (!row) return;
    const next = this.decay(row.gravity, row.gravity_at, now) + ATTENTION_WEIGHTS[kind];
    this.db
      .prepare(`UPDATE artworks SET gravity = ?, gravity_at = ? WHERE id = ?`)
      .run(next, now, artworkId);
    this.db
      .prepare(
        `INSERT INTO explorations (artwork_id, kind, weight, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(artworkId, kind, ATTENTION_WEIGHTS[kind], now);
  }

  /**
   * Presentation value in 0..1. Deliberately compressive: the difference
   * between a quiet piece and a much-discovered one is a matter of glow, never
   * of scale (§13 "no giant celebrity nodes").
   */
  presentation(rawGravity: number, gravityAt: number, now = this.clock.now()): number {
    const decayed = this.decay(rawGravity, gravityAt, now);
    return CEILING * (1 - Math.exp(-decayed / SATURATION));
  }

  band(presentation: number): GravityBand {
    if (presentation < 0.12) return 'quiet';
    if (presentation < 0.35) return 'stirring';
    if (presentation < 0.58) return 'discovered';
    return 'luminous';
  }

  /**
   * Private, qualitative signals for My Universe. Never a count, never a rank —
   * the answer to "something happened to my art while I was gone".
   */
  signalsFor(artworkId: string): QualitativeSignal[] {
    const now = this.clock.now();
    const week = 7 * 24 * 3600_000;
    const recent = this.db
      .prepare(
        `SELECT kind, SUM(weight) AS w, COUNT(*) AS n FROM explorations
         WHERE artwork_id = ? AND created_at > ? GROUP BY kind`
      )
      .all(artworkId, now - week) as { kind: string; w: number; n: number }[];
    const prior = this.db
      .prepare(
        `SELECT SUM(weight) AS w FROM explorations
         WHERE artwork_id = ? AND created_at BETWEEN ? AND ?`
      )
      .get(artworkId, now - 2 * week, now - week) as { w: number | null };

    const by = new Map(recent.map((r) => [r.kind, r]));
    const total = recent.reduce((a, r) => a + r.w, 0);
    const responses = this.db
      .prepare(`SELECT COUNT(*) AS n FROM artworks WHERE responds_to = ? AND status = 'published'`)
      .get(artworkId) as { n: number };

    const signals: QualitativeSignal[] = [];
    if (responses.n > 0) signals.push('inspiring_others');
    if (total > 0.5) signals.push('being_discovered');
    if ((by.get('explore_related')?.n ?? 0) >= 3) signals.push('traveling');
    if (total > (prior.w ?? 0) * 1.8 && total > 0.8) signals.push('lighting_up');
    if (!signals.length) signals.push('resting');
    return signals;
  }
}
