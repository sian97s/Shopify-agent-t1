import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { buildView } from './view.js';
import { REPORT_REASONS, type ReportReason } from '../domain/reporting/index.js';
import { toNode } from '../domain/artwork/present.js';
import type { ArtworkDetail } from '../../../shared/types.js';
import { RateLimiter } from './ratelimit.js';
import type { KeySessionTokens } from './keysession.js';

const viewportSchema = z.object({
  minX: z.coerce.number(),
  minY: z.coerce.number(),
  maxX: z.coerce.number(),
  maxY: z.coerce.number(),
  limit: z.coerce.number().min(1).max(400).default(220)
});

const anon = (req: { header(name: string): string | undefined }) =>
  req.header('x-anon')?.slice(0, 64) || 'anonymous';

export function universeRoutes(ctx: AppContext, keySessions: KeySessionTokens): Router {
  const router = Router();
  const reactionLimit = new RateLimiter(120, 60_000);
  const reportLimit = new RateLimiter(20, 60_000);

  /**
   * The living universe for the current viewport. The renderer asks for a box;
   * the server never returns more than a bounded, gravity-weighted subset of it.
   */
  router.get('/universe', (req, res) => {
    const parsed = viewportSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'bad_viewport' });
    const box = parsed.data;
    let records = ctx.artworks.inViewport(box, box.limit);

    // A first visitor with an empty viewport should still land in something
    // alive: fall back to a discovery sample rather than an empty sky.
    if (records.length < 12) {
      const sample = ctx.discovery
        .rank(
          ctx.artworks.live().map((artwork) => ({ artwork, relevance: 0.5 })),
          { seed: 'open' }
        )
        .slice(0, 80)
        .map((c) => c.artwork);
      const seen = new Set(records.map((r) => r.id));
      records = [...records, ...sample.filter((s) => !seen.has(s.id))];
    }
    res.json(buildView(ctx, records, { context: 'viewport' }));
  });

  /** Selecting an artwork reorganises space around it. */
  router.get('/universe/around/:ref', (req, res) => {
    const artwork = ctx.artworks.byRef(req.params.ref);
    if (!artwork || artwork.status !== 'published') return res.status(404).json({ error: 'not_found' });

    const related = ctx.search.byArtwork(artwork.id, { limit: 48 });
    const responses = ctx.artworks.responsesTo(artwork.id);
    const records = [artwork, ...responses, ...related.candidates.map((c) => c.artwork)];
    const unique = [...new Map(records.map((r) => [r.id, r])).values()];

    ctx.gravity.record(artwork.id, 'explore_related');
    res.json(
      buildView(ctx, unique, {
        focus: { x: artwork.x, y: artwork.y },
        context: `around:${artwork.publicRef}`,
        edgesPerNode: 4
      })
    );
  });

  /**
   * Search. There is no results page — this returns a new arrangement of the
   * universe, and the client animates the reorganisation.
   */
  router.post('/search', (req, res) => {
    const query = String(req.body?.query ?? '').slice(0, 200).trim();
    if (!query) return res.status(400).json({ error: 'empty_query' });
    const result = ctx.search.byText(query, { limit: 110 });
    res.json(
      buildView(ctx, result.candidates.map((c) => c.artwork), {
        focus: result.focus ? { ...result.focus, zoom: 0.55 } : null,
        context: `search:${query.slice(0, 40)}`
      })
    );
  });

  /** More like this. */
  router.get('/art/:ref/similar', (req, res) => {
    const artwork = ctx.artworks.byRef(req.params.ref);
    if (!artwork) return res.status(404).json({ error: 'not_found' });
    const result = ctx.search.byArtwork(artwork.id, { limit: 70 });
    ctx.gravity.record(artwork.id, 'explore_related');
    res.json(
      buildView(ctx, [artwork, ...result.candidates.map((c) => c.artwork)], {
        focus: result.focus ? { ...result.focus, zoom: 0.7 } : null,
        context: `similar:${artwork.publicRef}`
      })
    );
  });

  router.get('/art/:ref', (req, res) => {
    const artwork = ctx.artworks.byRef(req.params.ref);
    if (!artwork || artwork.status === 'removed') return res.status(404).json({ error: 'not_found' });
    const viewerKey = keySessions.verify(req.header('x-art-key-session') ?? undefined);
    const owned = !!viewerKey && artwork.artKeyId === viewerKey;
    if (artwork.visibility === 'private' && !owned) return res.status(404).json({ error: 'not_found' });

    ctx.gravity.record(artwork.id, 'view');
    const node = toNode(artwork, {
      storage: ctx.storage,
      gravity: ctx.gravity,
      refOf: (id) => ctx.artworks.byId(id)?.publicRef ?? null
    });
    const detail: ArtworkDetail = {
      ...node,
      owned,
      reacted: ctx.reactions.mine(artwork.id, anon(req)),
      // Qualitative signals are the owner's alone. Nobody else sees them.
      signals: owned ? ctx.gravity.signalsFor(artwork.id) : undefined
    };
    res.json(detail);
  });

  router.post('/art/:ref/react', (req, res) => {
    if (!reactionLimit.take(anon(req))) return res.status(429).json({ error: 'slow_down' });
    const kind = req.body?.kind;
    if (kind !== 'appreciate' && kind !== 'inspired') return res.status(400).json({ error: 'bad_kind' });
    const artwork = ctx.artworks.byRef(req.params.ref);
    if (!artwork || artwork.visibility !== 'universe') return res.status(404).json({ error: 'not_found' });
    const added = ctx.reactions.react(artwork.id, anon(req), kind);
    // No totals are returned. There is nothing to count.
    res.json({ ok: true, added });
  });

  router.post('/art/:ref/report', (req, res) => {
    if (!reportLimit.take(anon(req))) return res.status(429).json({ error: 'slow_down' });
    const reason = req.body?.reason as ReportReason;
    if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: 'bad_reason' });
    const artwork = ctx.artworks.byRef(req.params.ref);
    if (!artwork) return res.status(404).json({ error: 'not_found' });
    ctx.reporting.report(artwork.id, reason, anon(req));
    res.json({ ok: true });
  });

  return router;
}
