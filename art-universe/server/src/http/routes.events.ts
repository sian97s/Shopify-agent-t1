import { Router } from 'express';
import type { AppContext } from '../context.js';
import { AnalyticsService } from '../domain/analytics/index.js';
import { RateLimiter } from './ratelimit.js';

/** Anonymous aggregate analytics in, experiment assignment out. Nothing else. */
export function eventRoutes(ctx: AppContext): Router {
  const router = Router();
  const limiter = new RateLimiter(400, 60_000);

  router.post('/events', (req, res) => {
    const anon = req.header('x-anon')?.slice(0, 64) || 'anonymous';
    if (!limiter.take(anon)) return res.status(429).json({ error: 'slow_down' });
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 40) : [];
    let accepted = 0;
    for (const e of events) {
      if (typeof e?.name !== 'string') continue;
      if (ctx.analytics.record(e.name, e.props ?? {}, anon)) accepted++;
    }
    res.json({ accepted });
  });

  /**
   * The variant this anonymous session sees. Assignment is a pure hash, so no
   * per-visitor state is stored anywhere.
   */
  router.get('/experiments/assignment', (req, res) => {
    const anon = req.header('x-anon')?.slice(0, 64) || 'anonymous';
    const day = new Date(ctx.clock.now()).toISOString().slice(0, 10);
    const bucket = AnalyticsService.bucketFor(anon, day);
    res.json({ variant: ctx.evolution.assignmentFor(bucket) });
  });

  return router;
}
