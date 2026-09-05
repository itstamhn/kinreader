import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
  // `envDir` deliberately left at its default (this package). It used to point
  // at the workspace root, which meant Vite read the root `.env.local` (dev)
  // and never saw `apps/web/.env.production` -- so `vite build` inlined the
  // *dev* Convex URL into the production bundle, while the Worker proxied
  // /api/auth and /api/tts to prod (src/worker.ts). Env files for this app
  // live in this directory; keep them here.
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    port: 3000,
    proxy: env.VITE_CONVEX_SITE_URL ? { '/api/tts': { target: env.VITE_CONVEX_SITE_URL, changeOrigin: true }, '/api/auth': { target: env.VITE_CONVEX_SITE_URL, changeOrigin: true } } : undefined,
  },
};
});
