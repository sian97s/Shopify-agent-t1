import crypto from 'node:crypto';
import { Router } from 'express';
import type { AppContext } from '../context.js';

/**
 * Moderation administration and the evolution log.
 *
 * Deliberately unglamorous and completely separate from the product surface:
 * nothing here is reachable from the universe, and it never exposes creators.
 */
export function adminRoutes(ctx: AppContext): Router {
  const router = Router();

  router.use((req, res, next) => {
    const provided = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const expected = ctx.config.adminToken;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'unauthorised' });
    }
    next();
  });

  /**
   * Only live sessions appear here. A submission whose creator has left is
   * gone — it is never held for later publication.
   */
  router.get('/review', (_req, res) => {
    const sessions = ctx.sessions.liveAwaitingReview().map((s) => {
      const run = ctx.db
        .prepare(`SELECT checks, detail FROM moderation_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(s.id) as { checks: string; detail: string | null } | undefined;
      return {
        sessionId: s.id,
        visibility: s.visibility,
        waitingMs: ctx.clock.now() - s.createdAt,
        notes: run?.detail ?? '',
        checks: JSON.parse(run?.checks ?? '[]')
      };
    });
    res.json({ sessions });
  });

  router.post('/review/:sessionId', async (req, res) => {
    const approve = req.body?.approve === true;
    const result = await ctx.intake.review(req.params.sessionId, approve, 'admin');
    res.json(result);
  });

  router.get('/reports', (_req, res) => {
    res.json({ reports: ctx.reporting.open() });
  });

  router.post('/reports/:id', (req, res) => {
    const action = req.body?.action === 'actioned' ? 'actioned' : 'dismissed';
    ctx.reporting.resolve(req.params.id, action, req.body?.remove === true);
    res.json({ ok: true });
  });

  /** The evolution log: why every product change happened. */
  router.get('/evolution', (_req, res) => {
    res.json({
      experiments: ctx.evolution.all(),
      log: ctx.evolution.history()
    });
  });

  router.post('/evolution/tick', (_req, res) => {
    res.json(ctx.evolution.tick());
  });

  router.post('/evolution/:id/decide', (req, res) => {
    const decision = req.body?.decision;
    if (!['kept', 'modified', 'rolled_back'].includes(decision)) {
      return res.status(400).json({ error: 'bad_decision' });
    }
    ctx.evolution.decide(req.params.id, decision, String(req.body?.result ?? '').slice(0, 500));
    res.json({ ok: true });
  });

  /** A protected-surface proposal can only ever start running through here. */
  router.post('/evolution/:id/approve', (req, res) => {
    ctx.evolution.humanApprove(req.params.id, 'admin', Number(req.body?.audiencePct ?? 0.1));
    res.json({ ok: true });
  });

  return router;
}
