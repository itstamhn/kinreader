import { Spiceflow } from 'spiceflow';

export const app = new Spiceflow()
  // Health Check
  .get('/api/health', () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

// Start Spiceflow standalone if executed directly
if (import.meta.main) {
  const PORT = Number(process.env.API_PORT) || 3008;
  Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    fetch(req) {
      return app.handle(req);
    },
  });
  console.log(`✨ Spiceflow backend running on http://127.0.0.1:${PORT}`);
}
