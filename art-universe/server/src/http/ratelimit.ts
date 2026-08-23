/**
 * Small fixed-window limiter. It exists mainly to protect Art Key verification:
 * a memorable key is only safe if guessing is slow.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private limit: number, private windowMs: number) {}

  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 5000) this.sweep(now);
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }

  retryAfter(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    return entry ? Math.max(0, Math.ceil((entry.resetAt - now) / 1000)) : 0;
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
