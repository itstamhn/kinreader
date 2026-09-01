import { registerRoutes } from 'kitcn/auth/http';
import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { getAuth } from './generated/auth';
import { getEnv } from '../lib/get-env';
import { handleTtsStreamRequest } from '../lib/ttsStream';

const http = httpRouter();

registerRoutes(http, getAuth, {
  cors: {
    allowedOrigins: [
      getEnv().SITE_URL,
      'http://localhost:3000',
      'https://app.kinreader.com',
      'https://kinreader.com',
    ],
  },
});

// The reader's REST audio fallback. All request handling lives in
// lib/ttsStream.ts (pure, unit-tested); this file only supplies the
// deployment secret and the rate limiter, which needs a mutation to write
// its state. The limiter is the same pair `tts.synthesize` and
// `tts.temporaryKey` consume, so REST cannot become the cheap way around
// them.
const TTS_STREAM_ALLOWED_ORIGINS = [
  getEnv().SITE_URL,
  'http://localhost:3000',
  'https://app.kinreader.com',
  'https://kinreader.com',
];

const ttsStreamHandler = httpAction(async (ctx, req) => {
  return handleTtsStreamRequest(req, {
    apiKey: getEnv().SONIOX_API_KEY,
    allowedOrigins: TTS_STREAM_ALLOWED_ORIGINS,
    consumeRateLimit: async (key) => {
      const status: { ok: boolean } = await ctx.runMutation(
        internal.routers.ttsInternal.consumeTtsRateLimit,
        { key, purpose: 'synthesize' }
      );
      return status.ok;
    },
  });
});

for (const method of ['OPTIONS', 'GET', 'POST'] as const) {
  http.route({ path: '/api/tts/stream', method, handler: ttsStreamHandler });
}

// AutoSend Webhook Handler: List hygiene, bounce & complaint tracking
http.route({
  path: '/api/webhooks/autosend',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    let payload: any = {};
    try {
      payload = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const event = typeof payload.event === 'string' ? payload.event : (typeof payload.type === 'string' ? payload.type : '');
    const email = typeof payload.data?.email === 'string' 
      ? payload.data.email 
      : (typeof payload.email === 'string' ? payload.email : (typeof payload.recipient === 'string' ? payload.recipient : ''));

    if (email) {
      if (event.includes('bounce')) {
        await ctx.runMutation(internal.routers.users.markEmailBounced, { email });
      } else if (event.includes('complain')) {
        await ctx.runMutation(internal.routers.users.markEmailComplained, { email });
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
});

// RFC 8058 One-Click Unsubscribe (POST)
http.route({
  path: '/api/unsubscribe',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const email = url.searchParams.get('email');

    if (email) {
      await ctx.runMutation(internal.routers.digest.unsubscribeDigest as any, { email });
    }

    return new Response(JSON.stringify({ success: true, unsubscribed: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
});

// Web Browser Unsubscribe (GET)
http.route({
  path: '/api/unsubscribe',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const email = url.searchParams.get('email');

    if (email) {
      await ctx.runMutation(internal.routers.digest.unsubscribeDigest as any, { email });
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed · Kinreader</title>
  <style>
    body { margin: 0; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0B0C10; color: #ECEAE4; display: flex; justify-content: center; align-items: center; min-height: 80vh; }
    .card { max-width: 440px; background: #14151C; border: 1px solid #232530; border-radius: 16px; padding: 32px; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.5); }
    h1 { font-size: 20px; color: #F4F0E6; margin-bottom: 12px; }
    p { font-size: 14px; line-height: 1.6; color: #8E929E; margin-bottom: 24px; }
    a { display: inline-block; background: #F2A33C; color: #0B0C10; font-weight: bold; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 32px; margin-bottom: 16px;">⚡️</div>
    <h1>Unsubscribed Successfully</h1>
    <p>You have been removed from the Kinreader weekly reading digest. You will still receive essential transactional emails (like sign-in magic links).</p>
    <a href="https://kinreader.com">Return to Kinreader</a>
  </div>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }),
});

export default http;

