import crypto from 'node:crypto';
import type { Db } from '../../infra/db.js';
import type { Clock } from '../../infra/clock.js';
import { systemClock } from '../../infra/clock.js';

/** The complete list of things the product is allowed to observe. */
export const ALLOWED_EVENTS = [
  'universe_opened',
  'camera_moved',
  'artwork_selected',
  'artwork_deselected',
  'explore_similar',
  'search_started',
  'search_submitted',
  'search_refined',
  'search_abandoned',
  'upload_opened',
  'upload_chosen',
  'upload_abandoned',
  'upload_published',
  'reaction',
  'respond_started',
  'control_shown',
  'control_used',
  'gesture_failed',
  'render_slow',
  'key_returned'
] as const;

export type AnalyticsEvent = (typeof ALLOWED_EVENTS)[number];

const ALLOWED = new Set<string>(ALLOWED_EVENTS);

/**
 * Anonymous aggregate analytics.
 *
 * There is no user id here and there cannot be one: the bucket is a hash of a
 * per-visit token and the day, so it stops meaning anything at midnight and
 * cannot be joined to a person, a device or an Art Key. No IP, no user agent,
 * no referrer, no free text.
 */
export class AnalyticsService {
  constructor(private db: Db, private clock: Clock = systemClock) {}

  static bucketFor(anonymousToken: string, day: string): string {
    return crypto
      .createHash('sha256')
      .update(day)
      .update('|')
      .update(anonymousToken)
      .digest('base64url')
      .slice(0, 16);
  }

  private day(now = this.clock.now()) {
    return new Date(now).toISOString().slice(0, 10);
  }

  record(name: string, props: Record<string, unknown>, anonymousToken: string): boolean {
    if (!ALLOWED.has(name)) return false;
    const now = this.clock.now();
    const day = this.day(now);
    this.db
      .prepare(
        `INSERT INTO analytics_events (name, props, bucket, day, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(name, JSON.stringify(sanitise(props)), AnalyticsService.bucketFor(anonymousToken, day), day, now);
    return true;
  }

  countsByName(sinceDays = 14): Record<string, number> {
    const since = this.day(this.clock.now() - sinceDays * 86400_000);
    const rows = this.db
      .prepare(`SELECT name, COUNT(*) AS n FROM analytics_events WHERE day >= ? GROUP BY name`)
      .all(since) as { name: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.n]));
  }

  /** Buckets that did X but never did Y — the shape most observations need. */
  bucketsMissingFollowUp(first: string, follow: string, sinceDays = 14): { with: number; without: number } {
    const since = this.day(this.clock.now() - sinceDays * 86400_000);
    const row = this.db
      .prepare(
        `WITH firsts AS (SELECT DISTINCT bucket FROM analytics_events WHERE name = ? AND day >= ?),
              follows AS (SELECT DISTINCT bucket FROM analytics_events WHERE name = ? AND day >= ?)
         SELECT (SELECT COUNT(*) FROM firsts WHERE bucket IN (SELECT bucket FROM follows)) AS w,
                (SELECT COUNT(*) FROM firsts WHERE bucket NOT IN (SELECT bucket FROM follows)) AS wo`
      )
      .get(first, since, follow, since) as { w: number; wo: number };
    return { with: row.w, without: row.wo };
  }

  /** Delete raw events beyond the retention window; aggregates are all we keep. */
  prune(retentionDays = 30): number {
    const cutoff = this.day(this.clock.now() - retentionDays * 86400_000);
    return this.db.prepare(`DELETE FROM analytics_events WHERE day < ?`).run(cutoff).changes;
  }
}

/** Numbers, booleans and short enum-ish strings only. Never free text. */
function sanitise(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props).slice(0, 12)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 24 && /^[a-z0-9_.:-]+$/i.test(v)) out[k] = v;
  }
  return out;
}
