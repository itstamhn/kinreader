import { test, expect } from 'bun:test';
import { handleTtsStreamRequest, MAX_REST_FALLBACK_CHARS } from './ttsStream';

const ALLOWED = ['https://app.kinreader.com', 'http://localhost:3000'];

function deps(overrides: Partial<Parameters<typeof handleTtsStreamRequest>[1]> = {}) {
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    // Echo the chunk text as "audio" so the test can check ordering and
    // completeness of the concatenated stream.
    return new Response(new TextEncoder().encode(`[${body.text}]`), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    calls,
    deps: {
      apiKey: 'server-key',
      allowedOrigins: ALLOWED,
      consumeRateLimit: async () => true,
      fetcher,
      ...overrides,
    },
  };
}

function getRequest(params: Record<string, string>, headers: Record<string, string> = {}) {
  const url = new URL('https://deployment.convex.site/api/tts/stream');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, { headers });
}

test('streams every chunk in order as one continuous body', async () => {
  const text = 'a'.repeat(450) + ' ' + 'b'.repeat(450) + ' ' + 'c'.repeat(10);
  const { deps: d, calls } = deps();
  const res = await handleTtsStreamRequest(getRequest({ text, voice: 'Adrian' }), d);

  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  const body = await res.text();
  // Three chunks, concatenated in the order they were sent.
  expect(calls).toHaveLength(3);
  expect(body.replaceAll('[', '').replaceAll(']', '')).toBe(text);
  expect(body.indexOf('[aaaa')).toBe(0);
  expect(calls[0]!.body.speed).toBe(1.0);
  expect(calls[0]!.body.voice).toBe('Adrian');
});

test('a denied rate limit returns 429 and never reaches Soniox', async () => {
  const keys: string[] = [];
  const { deps: d, calls } = deps({
    consumeRateLimit: async (key) => {
      keys.push(key);
      return false;
    },
  });
  const res = await handleTtsStreamRequest(getRequest({ text: 'hello', clientId: 'client-1' }), d);

  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('60');
  expect(keys).toEqual(['client-1']);
  expect(calls).toHaveLength(0);
});

test('a missing clientId shares the anonymous bucket', async () => {
  const keys: string[] = [];
  const { deps: d } = deps({
    consumeRateLimit: async (key) => {
      keys.push(key);
      return true;
    },
  });
  await handleTtsStreamRequest(getRequest({ text: 'hello' }), d);
  expect(keys).toEqual(['anonymous']);
});

test('text over the REST cap is rejected with 413 before any limiter or upstream call', async () => {
  let limiterCalls = 0;
  const { deps: d, calls } = deps({
    consumeRateLimit: async () => {
      limiterCalls += 1;
      return true;
    },
  });
  const res = await handleTtsStreamRequest(
    getRequest({ text: 'x'.repeat(MAX_REST_FALLBACK_CHARS + 1) }),
    d
  );
  expect(res.status).toBe(413);
  expect(limiterCalls).toBe(0);
  expect(calls).toHaveLength(0);

  const ok = await handleTtsStreamRequest(getRequest({ text: 'x'.repeat(MAX_REST_FALLBACK_CHARS) }), d);
  expect(ok.status).toBe(200);
});

test('missing text is a 400 and a missing key is a 500, both without upstream calls', async () => {
  const { deps: d, calls } = deps();
  expect((await handleTtsStreamRequest(getRequest({ text: '   ' }), d)).status).toBe(400);
  expect((await handleTtsStreamRequest(getRequest({}), d)).status).toBe(400);

  const { deps: noKey, calls: noKeyCalls } = deps({ apiKey: undefined });
  expect((await handleTtsStreamRequest(getRequest({ text: 'hello' }), noKey)).status).toBe(500);
  expect(calls).toHaveLength(0);
  expect(noKeyCalls).toHaveLength(0);
});

test('POST bodies are validated and clamped like GET queries', async () => {
  const { deps: d, calls } = deps();
  const res = await handleTtsStreamRequest(
    new Request('https://deployment.convex.site/api/tts/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello there', voice: 'Emma', speed: 9, clientId: 'c' }),
    }),
    d
  );
  expect(res.status).toBe(200);
  await res.text();
  expect(calls[0]!.body.voice).toBe('Emma');
  expect(calls[0]!.body.speed).toBe(1.3);

  const bad = await handleTtsStreamRequest(
    new Request('https://deployment.convex.site/api/tts/stream', { method: 'POST', body: '{not json' }),
    d
  );
  expect(bad.status).toBe(400);
});

test('an invalid voice is rejected instead of being forwarded to Soniox', async () => {
  const { deps: d, calls } = deps();
  const res = await handleTtsStreamRequest(getRequest({ text: 'hello', voice: 'Adrian"; drop' }), d);
  expect(res.status).toBe(400);
  expect(calls).toHaveLength(0);
});

test('CORS is reflected only for allowed origins', async () => {
  const { deps: d } = deps();

  const allowed = await handleTtsStreamRequest(
    getRequest({ text: 'hello' }, { origin: 'https://app.kinreader.com' }),
    d
  );
  expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://app.kinreader.com');
  expect(allowed.headers.get('Vary')).toBe('Origin');

  const foreign = await handleTtsStreamRequest(
    getRequest({ text: 'hello' }, { origin: 'https://evil.example' }),
    d
  );
  expect(foreign.status).toBe(200);
  expect(foreign.headers.get('Access-Control-Allow-Origin')).toBeNull();

  const preflight = await handleTtsStreamRequest(
    new Request('https://deployment.convex.site/api/tts/stream', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000' },
    }),
    d
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
});

test('an upstream rejection on the first chunk surfaces as an HTTP error status', async () => {
  const { deps: d } = deps({
    fetcher: (async () => new Response('nope', { status: 402 })) as unknown as typeof fetch,
  });
  const res = await handleTtsStreamRequest(getRequest({ text: 'hello' }), d);
  expect(res.status).toBe(402);
});
