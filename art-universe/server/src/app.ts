import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AppContext } from './context.js';
import { KeySessionTokens } from './http/keysession.js';
import { universeRoutes } from './http/routes.universe.js';
import { uploadRoutes } from './http/routes.upload.js';
import { meRoutes } from './http/routes.me.js';
import { eventRoutes } from './http/routes.events.js';
import { adminRoutes } from './http/routes.admin.js';
import { RealtimeHub } from './infra/realtime.js';

export interface AppHandle {
  app: express.Express;
  attachRealtime(server: Server): RealtimeHub;
  startBackgroundWork(): void;
  stop(): void;
}

/** Secret for stateless Art Key session tokens; rotating it just logs people out. */
function keySessionSecret(dataDir: string): Buffer {
  const file = path.join(dataDir, 'session.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function createApp(ctx: AppContext): AppHandle {
  const app = express();
  const keySessions = new KeySessionTokens(keySessionSecret(ctx.config.dataDir));
  let hub: RealtimeHub | null = null;
  const timers: NodeJS.Timeout[] = [];

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));

  app.use('/api', universeRoutes(ctx, keySessions));
  app.use('/api', uploadRoutes(ctx, keySessions, () => hub));
  app.use('/api', meRoutes(ctx, keySessions));
  app.use('/api', eventRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      artworks: ctx.artworks.countLive(),
      ai: ctx.ai.name
    });
  });

  // Derivatives are immutable once written, so they can be cached hard.
  app.use(
    '/media',
    express.static(ctx.config.mediaDir, {
      immutable: true,
      maxAge: '365d',
      fallthrough: false
    })
  );

  const webDir = path.resolve('dist/web');
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir, { maxAge: '1h', index: false }));
    // Every route is the universe. /art/:ref just opens it on that artwork.
    app.get(/^(?!\/api|\/media).*/, (_req, res) => {
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  return {
    app,
    attachRealtime(server: Server) {
      hub = new RealtimeHub(server, '/ws/upload');
      hub.onSessionAttached((sessionId) => ctx.sessions.connectionOpened(sessionId));
      hub.onSessionDisconnected((sessionId) => ctx.sessions.connectionClosed(sessionId));
      hub.handle((msg, socket) => {
        if (!socket.sessionId) return;
        if (msg.type === 'heartbeat' || msg.type === 'attach') {
          const session = ctx.sessions.heartbeat(socket.sessionId);
          socket.send({ type: 'alive', state: session?.state ?? 'cancelled' });
        }
      });
      // Every state change reaches the waiting creator immediately.
      ctx.sessions.onChange((session) => {
        hub?.broadcast(session.id, {
          type: 'state',
          payload: { sessionId: session.id, state: session.state, reason: session.reason }
        });
      });
      return hub;
    },
    startBackgroundWork() {
      // Sessions cannot survive a restart.
      ctx.sessions.cancelAllLive('server_restart');
      timers.push(
        setInterval(() => {
          for (const cancelled of ctx.sessions.reap()) {
            void ctx.intake.discard(cancelled.id, 'reaped');
          }
        }, ctx.config.sessionReaperIntervalMs)
      );
      // The evolution loop observes, proposes and logs — slowly and in public.
      timers.push(setInterval(() => ctx.evolution.tick(), 60 * 60_000));
      timers.push(setInterval(() => ctx.analytics.prune(), 6 * 3600_000));
      for (const t of timers) t.unref?.();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      hub?.close();
    }
  };
}
