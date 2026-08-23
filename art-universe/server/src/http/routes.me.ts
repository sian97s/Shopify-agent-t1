import { Router } from 'express';
import type { AppContext } from '../context.js';
import type { MyUniverse, QualitativeSignal } from '../../../shared/types.js';
import { toNode } from '../domain/artwork/present.js';
import { RateLimiter } from './ratelimit.js';
import type { KeySessionTokens } from './keysession.js';

/**
 * Returning with an Art Key, and My Universe.
 *
 * There is no login screen, no account, and nothing here that could become a
 * public identity: no bio, no name, no counts.
 */
export function meRoutes(ctx: AppContext, keySessions: KeySessionTokens): Router {
  const router = Router();
  // Art Key guessing must stay slow. Per-address and global windows both apply.
  const perClient = new RateLimiter(8, 10 * 60_000);
  const global = new RateLimiter(600, 10 * 60_000);

  router.post('/key/return', async (req, res) => {
    const client = req.ip ?? 'unknown';
    if (!perClient.take(client) || !global.take('all')) {
      return res.status(429).json({ error: 'slow_down', retryAfter: perClient.retryAfter(client) });
    }
    const raw = String(req.body?.key ?? '').slice(0, 120);
    const artKeyId = await ctx.artKeys.resolve(raw);
    if (!artKeyId) return res.status(401).json({ error: 'unknown_key' });
    res.json({ session: keySessions.issue(artKeyId) });
  });

  const requireKey = (req: { header(n: string): string | undefined }): string | null =>
    keySessions.verify(req.header('x-art-key-session') ?? undefined);

  /** The creator's own constellation. Private pieces included; nobody else can see it. */
  router.get('/me/universe', (req, res) => {
    const artKeyId = requireKey(req);
    if (!artKeyId) return res.status(401).json({ error: 'no_key' });

    const mine = ctx.artworks.ownedBy(artKeyId);
    const refOf = (id: string) => ctx.artworks.byId(id)?.publicRef ?? null;
    const nodes = mine.map((a) => toNode(a, { storage: ctx.storage, gravity: ctx.gravity, refOf }));

    // Bring in the work that answered theirs, so returning shows what happened.
    const responses = mine.flatMap((a) => ctx.artworks.responsesTo(a.id));
    const all = [...mine, ...responses];
    const refById = new Map(all.map((a) => [a.id, a.publicRef]));
    const edges = ctx.relationships.edgesFor(all.map((a) => a.id), refById, 4);

    const signals: Record<string, QualitativeSignal[]> = {};
    for (const a of mine) signals[a.publicRef] = ctx.gravity.signalsFor(a.id);

    const payload: MyUniverse = {
      nodes: [
        ...nodes,
        ...responses.map((a) => toNode(a, { storage: ctx.storage, gravity: ctx.gravity, refOf }))
      ],
      edges,
      signals
    };
    res.json(payload);
  });

  router.patch('/me/art/:ref', (req, res) => {
    const artKeyId = requireKey(req);
    if (!artKeyId) return res.status(401).json({ error: 'no_key' });
    const artwork = ctx.artworks.byRef(req.params.ref);
    if (!artwork) return res.status(404).json({ error: 'not_found' });
    if (!ctx.ownership.owns(artKeyId, artwork.id)) return res.status(403).json({ error: 'forbidden' });

    if (typeof req.body?.title === 'string') {
      const title = req.body.title.slice(0, 80).trim();
      ctx.artworks.setTitle(artwork.id, title || null, title ? 'creator' : null);
    }
    if (req.body?.visibility === 'private' || req.body?.visibility === 'universe') {
      ctx.artworks.setVisibility(artwork.id, req.body.visibility);
    }
    const updated = ctx.artworks.byId(artwork.id)!;
    res.json(
      toNode(updated, {
        storage: ctx.storage,
        gravity: ctx.gravity,
        refOf: (id) => ctx.artworks.byId(id)?.publicRef ?? null
      })
    );
  });

  /** Withdraw a piece from the universe. The creator's own work, their call. */
  router.delete('/me/art/:ref', (req, res) => {
    const artKeyId = requireKey(req);
    if (!artKeyId) return res.status(401).json({ error: 'no_key' });
    const artwork = ctx.artworks.byRef(req.params.ref);
    if (!artwork) return res.status(404).json({ error: 'not_found' });
    if (!ctx.ownership.owns(artKeyId, artwork.id)) return res.status(403).json({ error: 'forbidden' });
    ctx.artworks.remove(artwork.id);
    res.json({ ok: true });
  });

  return router;
}
