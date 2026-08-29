import { registerRoutes } from 'kitcn/auth/http';
import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { getAuth } from './generated/auth';
import { getEnv } from '../lib/get-env';

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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Handle CORS preflight for audio streaming
http.route({
  path: '/api/tts/stream',
  method: 'OPTIONS',
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }),
});

// GET /api/tts/stream?text=...&voice=...&speed=...
http.route({
  path: '/api/tts/stream',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const text = url.searchParams.get('text');
    const voice = url.searchParams.get('voice') || 'Adrian';
    const rawSpeed = parseFloat(url.searchParams.get('speed') || '1.0');
    const speed = Math.max(0.7, Math.min(1.3, isNaN(rawSpeed) ? 1.0 : rawSpeed));
    const apiKey = getEnv().SONIOX_API_KEY || process.env.SONIOX_API_KEY;

    if (!text || !text.trim()) {
      return new Response(JSON.stringify({ error: 'Missing text query parameter' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'SONIOX_API_KEY not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      const sonioxRes = await fetch('https://tts-rt.soniox.com/tts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text.trim(),
          model: 'tts-rt-v2',
          language: 'en',
          voice,
          audio_format: 'mp3',
          speed,
          reduce_silence: false,
        }),
      });

      if (!sonioxRes.ok) {
        return new Response(sonioxRes.body, {
          status: sonioxRes.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(sonioxRes.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err?.message || 'Soniox streaming error' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }),
});

// POST /api/tts/stream with JSON body { text, voice, speed }
http.route({
  path: '/api/tts/stream',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const voice = typeof body.voice === 'string' ? body.voice : 'Adrian';
    const rawSpeed = typeof body.speed === 'number' ? body.speed : 1.0;
    const speed = Math.max(0.7, Math.min(1.3, isNaN(rawSpeed) ? 1.0 : rawSpeed));
    const apiKey = getEnv().SONIOX_API_KEY || process.env.SONIOX_API_KEY;

    if (!text) {
      return new Response(JSON.stringify({ error: 'Missing text in request body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'SONIOX_API_KEY not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      const sonioxRes = await fetch('https://tts-rt.soniox.com/tts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model: 'tts-rt-v2',
          language: 'en',
          voice,
          audio_format: 'mp3',
          speed,
          reduce_silence: false,
        }),
      });

      if (!sonioxRes.ok) {
        return new Response(sonioxRes.body, {
          status: sonioxRes.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(sonioxRes.body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (err: any) {
      return new Response(JSON.stringify({ error: err?.message || 'Soniox streaming error' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }),
});

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

