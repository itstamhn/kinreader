import { test, expect } from 'bun:test';
import worker from './index';

const source = { contentDigest: 'a'.repeat(64), voice: 'Adrian' };
const env = { PACKAGER_SECRET: 'test-only-secret', CONVEX_URL: 'https://notable-camel-807.convex.cloud', AUDIO: { get: async () => null, put: async () => { throw new Error('Unexpected write'); } } };
test('rejects unsigned uploads and direct access through the storage hostname', async () => {
  expect((await worker.fetch(new Request('https://storage.workers.dev/internal/objects/x', { method: 'PUT', body: 'bytes' }), env as any)).status).toBe(403);
  expect((await worker.fetch(new Request('https://storage.workers.dev/api/tts/continuous', { method: 'POST', body: JSON.stringify(source) }), env as any)).status).toBe(404);
});
test('denied recording access cannot issue playback tickets', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ status: 'error' })) as typeof fetch;
  try {
    const response = await worker.fetch(new Request('https://app.kinreader.com/api/tts/continuous', { method: 'POST', body: JSON.stringify(source) }), env as any);
    expect(response.status).toBe(403);
  } finally { globalThis.fetch = original; }
});
test('completed recordings are reused and playback tickets cannot be altered', async () => {
  const original = globalThis.fetch;
  const originalNow = Date.now;
  let now = 2_000_000_000_000;
  Date.now = () => now;
  let checks = 0;
  globalThis.fetch = (async () => { checks++; return Response.json({ status: 'success', value: { total: 4 } }); }) as typeof fetch;
  const cached = { ...env, AUDIO: { get: async () => ({ json: async () => ({ generation: 'b'.repeat(32) }) }) } };
  try {
    const response = await worker.fetch(new Request('https://app.kinreader.com/api/tts/continuous', { method: 'POST', body: JSON.stringify(source) }), cached as any);
    const urls = await response.json() as { timeline: string };
    const repeated = await worker.fetch(new Request('https://app.kinreader.com/api/tts/continuous', { method: 'POST', body: JSON.stringify(source) }), cached as any);
    expect(await repeated.json()).toEqual(urls);
    expect(response.status).toBe(200);
    expect(checks).toBe(2);
    const pieces = urls.timeline.split('/');
    const ticket = pieces[4]!;
    const encoded = ticket.split('.')[0]!.replaceAll('-', '+').replaceAll('_', '/');
    const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))) as { expires: number };
    expect(payload.expires - now).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
    expect(payload.expires - now).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    pieces[4] = ticket.slice(0, -1) + (ticket.endsWith('0') ? '1' : '0');
    expect((await worker.fetch(new Request('https://app.kinreader.com' + pieces.join('/')), env as any)).status).toBe(403);
    now = payload.expires + 1;
    expect((await worker.fetch(new Request('https://app.kinreader.com' + urls.timeline), env as any)).status).toBe(403);
    now = 2_000_000_000_000;
    expect((await worker.fetch(new Request('https://app.kinreader.com' + urls.timeline), env as any)).status).toBe(404);
    const media = { ...env, AUDIO: { get: async () => ({ size: 5, range: { offset: 0, length: 5 }, body: 'audio', writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'audio/mp4'); } }) } };
    const full = await worker.fetch(new Request('https://app.kinreader.com' + urls.timeline), media as any);
    expect(full.status).toBe(200);
    expect(full.headers.has('Content-Range')).toBe(false);
    const partial = await worker.fetch(new Request('https://app.kinreader.com' + urls.timeline, { headers: { Range: 'bytes=0-4' } }), media as any);
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 0-4/5');
  } finally { globalThis.fetch = original; Date.now = originalNow; }
});

test('missing optional conversion falls back immediately without starting work', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ status: 'success', value: { total: 4 } }); }) as typeof fetch;
  try {
    const response = await worker.fetch(new Request('https://app.kinreader.com/api/tts/continuous', { method: 'POST', body: JSON.stringify(source) }), env as any);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ unavailable: true });
    expect(requests).toBe(1);
  } finally { globalThis.fetch = original; }
});
