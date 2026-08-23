import http from 'node:http';
import { createContext } from './context.js';
import { createApp } from './app.js';

const ctx = createContext();
const handle = createApp(ctx);
const server = http.createServer(handle.app);
handle.attachRealtime(server);
handle.startBackgroundWork();

server.listen(ctx.config.port, () => {
  const count = ctx.artworks.countLive();
  console.log(`Art Universe listening on :${ctx.config.port}`);
  console.log(`  artworks in the universe: ${count}`);
  console.log(`  AI provider: ${ctx.ai.name}${ctx.ai.name === 'local' ? ' (offline mode)' : ''}`);
  if (!process.env.ADMIN_TOKEN) {
    console.log(`  admin token (set ADMIN_TOKEN to fix it): ${ctx.config.adminToken}`);
  }
  if (count === 0) console.log('  the universe is empty — run: npm run seed');
});

const shutdown = () => {
  handle.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
