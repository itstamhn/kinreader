
interface Env {
  AUDIO: R2Bucket;
  PACKAGER_SECRET: string;
  CONVEX_URL: string;
}
const encoder = new TextEncoder();
const prefix = 'continuous-v1/';
async function mac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
async function ticket(env: Env, path: string) {
  const hour = 3600000;
  const expires = Math.ceil((Date.now() + 23 * hour) / hour) * hour;
  const payload = btoa(JSON.stringify({ path, expires })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${payload}.${hex(await mac(env.PACKAGER_SECRET, payload))}`;
}
async function unticket(env: Env, value: string) {
  const [payload, signature] = value.split('.');
  if (!payload || !signature || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid ticket');
  const expected = hex(await mac(env.PACKAGER_SECRET, payload));
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (difference) throw new Error('Invalid ticket');
  const data = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
  if (typeof data.expires !== 'number' || data.expires < Date.now() || !/^[a-f0-9]{64}\/[a-f0-9]{32}$/.test(data.path)) throw new Error('Expired ticket');
  return data.path as string;
}
const filePattern = /^(?:init\.mp4|segment-\d{5}\.m4s|index\.m3u8|timeline\.json|error\.json)$/;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Only the packager can write files. The R2 bucket has no public hostname.
    if (url.pathname.startsWith('/internal/objects/') && request.method === 'PUT') {
      if (request.headers.get('Authorization') !== `Bearer ${env.PACKAGER_SECRET}`) return new Response(null, { status: 403 });
      const path = url.pathname.slice('/internal/objects/'.length);
      if (!/^[a-f0-9]{64}\/(?:complete\.json|[a-f0-9]{32}\/(?:init\.mp4|segment-\d{5}\.m4s|index\.m3u8|timeline\.json|error\.json))$/.test(path)) return new Response(null, { status: 400 });
      await env.AUDIO.put(prefix + path, request.body, { httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' } });
      return new Response(null, { status: 204 });
    }
    // The public storage hostname only accepts authenticated uploads. The
    // reader calls these routes through its private Worker service binding.
    if (url.hostname !== 'app.kinreader.com' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return new Response(null, { status: 404 });
    if (request.method === 'POST' && url.pathname === '/api/tts/continuous') {
      if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return new Response(null, { status: 403 });
      try {
        const body: any = await request.json();
        if (!/^[a-f0-9]{64}$/.test(body.contentDigest) || typeof body.voice !== 'string' || body.voice.length > 100 ||
            (body.recordingId !== undefined && (typeof body.recordingId !== 'string' || body.recordingId.length > 100)) ||
            (body.ownerToken !== undefined && (typeof body.ownerToken !== 'string' || body.ownerToken.length > 200))) return new Response(null, { status: 400 });
        const input = { contentDigest: body.contentDigest, voice: body.voice, ...(body.recordingId ? { recordingId: body.recordingId, ...(body.ownerToken ? { ownerToken: body.ownerToken } : {}) } : {}) };
        // Resolve access and source data through the existing narration API.
        // Clients cannot choose source URLs or overwrite another recording.
        const result = await fetch(`${env.CONVEX_URL}/api/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'routers/narration:page', args: { ...input, from: 0 }, format: 'json' }) });
        const page: any = await result.json();
        if (!result.ok || page.status !== 'success') return Response.json({ error: 'Recording unavailable' }, { status: 403 });
        if (!page.value.total) return Response.json({ pending: true }, { status: 202 });
        const key = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([input.contentDigest, input.voice, input.recordingId || ''])))));
        const complete = await env.AUDIO.get(`${prefix}${key}/complete.json`);
        if (!complete) return Response.json({ unavailable: true }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
        const generation = (await complete.json<{ generation: string }>()).generation;
        const access = await ticket(env, `${key}/${generation}`);
        return Response.json({ timeline: `/api/tts/continuous/${access}/timeline.json`, playlist: `/api/tts/continuous/${access}/index.m3u8` }, { headers: { 'Cache-Control': 'no-store' } });
      } catch { return Response.json({ error: 'Audio packaging is unavailable' }, { status: 503 }); }
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/api/tts/continuous/')) {
      try {
        const parts = url.pathname.split('/');
        const path = await unticket(env, parts[4]);
        const file = parts[5];
        if (parts.length !== 6 || !filePattern.test(file)) return new Response(null, { status: 404 });
        const object = await env.AUDIO.get(`${prefix}${path}/${file}`, request.headers.has('Range') ? { range: request.headers } : undefined);
        if (!object) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
        const headers = new Headers({ 'Cache-Control': file.endsWith('.json') || file.endsWith('.m3u8') ? 'private, no-store' : 'private, max-age=3600', 'Accept-Ranges': 'bytes', 'Referrer-Policy': 'no-referrer' });
        object.writeHttpMetadata(headers);
        if (request.headers.has('Range') && object.range && 'offset' in object.range && object.range.offset !== undefined && object.range.length !== undefined) {
          headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
          headers.set('Content-Length', String(object.range.length));
        } else headers.set('Content-Length', String(object.size));
        return new Response(request.method === 'HEAD' ? null : object.body, { status: request.headers.has('Range') && object.range ? 206 : 200, headers });
      } catch { return new Response(null, { status: 403 }); }
    }
    return new Response(null, { status: 404 });
  },
};
