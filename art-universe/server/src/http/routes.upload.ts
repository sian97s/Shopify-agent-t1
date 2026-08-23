import { Router, raw } from 'express';
import type { AppContext } from '../context.js';
import type { UploadSessionPublic, Visibility } from '../../../shared/types.js';
import { SessionAuthError, SessionNotActiveError, type UploadSession } from '../domain/upload-session/service.js';
import { toNode } from '../domain/artwork/present.js';
import { RateLimiter } from './ratelimit.js';
import type { KeySessionTokens } from './keysession.js';
import type { RealtimeHub } from '../infra/realtime.js';

const publicView = (
  ctx: AppContext,
  session: UploadSession,
  extra: Partial<UploadSessionPublic> = {}
): UploadSessionPublic => {
  const artwork = session.artworkId ? ctx.artworks.byId(session.artworkId) : null;
  return {
    sessionId: session.id,
    state: session.state,
    reason: session.reason ?? undefined,
    suggestedTitle: session.suggestedTitle,
    heartbeatIntervalMs: ctx.config.heartbeatIntervalMs,
    artwork: artwork
      ? toNode(artwork, {
          storage: ctx.storage,
          gravity: ctx.gravity,
          refOf: (id) => ctx.artworks.byId(id)?.publicRef ?? null
        })
      : undefined,
    ...extra
  };
};

export function uploadRoutes(
  ctx: AppContext,
  keySessions: KeySessionTokens,
  hub: () => RealtimeHub | null
): Router {
  const router = Router();
  const startLimit = new RateLimiter(30, 10 * 60_000);

  const authorise = (req: { params: Record<string, string>; header(n: string): string | undefined }) =>
    ctx.sessions.authorise(req.params.id, req.header('x-session-token') ?? '');

  /** Open an upload session. Nothing is stored yet — this only starts the clock. */
  router.post('/upload/session', (req, res) => {
    const anon = req.header('x-anon')?.slice(0, 64) || 'anonymous';
    if (!startLimit.take(anon)) return res.status(429).json({ error: 'slow_down' });

    const visibility: Visibility = req.body?.visibility === 'private' ? 'private' : 'universe';
    const artKeyId = keySessions.verify(req.header('x-art-key-session') ?? undefined);
    const respondsToRef = typeof req.body?.respondsTo === 'string' ? req.body.respondsTo : null;
    const parent = respondsToRef ? ctx.artworks.byRef(respondsToRef) : null;
    if (respondsToRef && (!parent || parent.visibility !== 'universe')) {
      return res.status(404).json({ error: 'unknown_artwork' });
    }

    const { session, token } = ctx.sessions.create({
      artKeyId,
      visibility,
      respondsTo: parent?.id ?? null,
      title: typeof req.body?.title === 'string' ? req.body.title.slice(0, 80) : null
    });
    res.json({ ...publicView(ctx, session), token });
  });

  router.patch('/upload/:id', (req, res) => {
    try {
      const session = ctx.sessions.assertActive(authorise(req));
      if (typeof req.body?.title === 'string') {
        ctx.sessions.setTitle(session.id, req.body.title.slice(0, 80).trim() || null);
      }
      if (req.body?.visibility === 'private' || req.body?.visibility === 'universe') {
        ctx.sessions.setVisibility(session.id, req.body.visibility);
      }
      res.json(publicView(ctx, ctx.sessions.get(session.id)!));
    } catch (err) {
      respondToSessionError(res, err);
    }
  });

  /**
   * The artwork itself. Moderation runs here, inside the request, while the
   * creator waits and the session heartbeat keeps the submission alive.
   */
  router.post(
    '/upload/:id/file',
    raw({ type: ['image/*', 'application/octet-stream'], limit: ctx.config.maxUploadBytes }),
    async (req, res) => {
      let session: UploadSession;
      try {
        session = ctx.sessions.assertActive(authorise(req));
      } catch (err) {
        return respondToSessionError(res, err);
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'no_image' });
      }

      const emit = (stage: string) =>
        hub()?.broadcast(session.id, { type: 'stage', stage });

      try {
        const result = await ctx.intake.submit(session, req.body, emit);
        const updated = ctx.sessions.get(session.id)!;
        const payload = publicView(ctx, updated, {
          artKey: result.artKey,
          suggestedTitle: result.suggestedTitle ?? updated.suggestedTitle
        });
        hub()?.broadcast(session.id, { type: 'state', payload: { ...payload, artKey: undefined } });
        res.json(payload);
      } catch (err) {
        // A failure here must never leave a half-published artwork behind.
        await ctx.intake.discard(session.id, 'error');
        ctx.sessions.cancel(session.id, 'error');
        res.status(500).json({ error: 'moderation_failed' });
      }
    }
  );

  router.post('/upload/:id/heartbeat', (req, res) => {
    try {
      const session = authorise(req);
      const updated = ctx.sessions.heartbeat(session.id);
      if (!updated) return res.status(404).json({ error: 'unknown_session' });
      res.json(publicView(ctx, updated));
    } catch (err) {
      respondToSessionError(res, err);
    }
  });

  router.get('/upload/:id', (req, res) => {
    try {
      res.json(publicView(ctx, authorise(req)));
    } catch (err) {
      respondToSessionError(res, err);
    }
  });

  /** Explicit abandonment. Also fired by the browser on unload. */
  router.post('/upload/:id/cancel', async (req, res) => {
    try {
      const session = authorise(req);
      await ctx.intake.discard(session.id, 'cancelled');
      const updated = ctx.sessions.cancel(session.id, 'user_cancelled');
      res.json(publicView(ctx, updated ?? session));
    } catch (err) {
      respondToSessionError(res, err);
    }
  });

  return router;
}

function respondToSessionError(res: { status(code: number): { json(body: unknown): void } }, err: unknown) {
  if (err instanceof SessionAuthError) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (err instanceof SessionNotActiveError) {
    res.status(409).json({ error: 'session_ended', state: err.state });
    return;
  }
  res.status(500).json({ error: 'unexpected' });
}
