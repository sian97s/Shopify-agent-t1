import { defineConfig } from 'vite';

const API = process.env.API_ORIGIN ?? 'http://localhost:8788';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2022' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/media': { target: API, changeOrigin: true },
      '/art': { target: API, changeOrigin: true },
      '/ws': { target: API, ws: true }
    }
  }
});
