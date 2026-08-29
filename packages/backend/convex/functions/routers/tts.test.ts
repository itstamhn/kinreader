import { test, expect, afterEach } from 'bun:test';
import { convexTest } from 'convex-test';
import { MINUTE, Ratelimit } from 'kitcn/ratelimit';
// kitcn's generated `api` surface is the type-complete one for cRPC
// procedures -- Convex's own `_generated/api.d.ts` type filters kitcn's
// wrapped `Procedure` out of `api.routers` entirely (see
// convex/routers/articles.test.ts for the full explanation).
import { api } from '../../shared/api';
import { internal } from '../_generated/api';
import schema from '../schema';
import { TTS_GLOBAL_KEY } from '../../lib/rateLimiter';

// See the comment in convex/routers/articles.test.ts for why this map is
// built by hand instead of `import.meta.glob` (unsupported under `bun
// test`) and why an entry containing "_generated" must be present. The rate
// limiter (convex/lib/rateLimiter.ts) is plain `ctx.db` reads/writes
// against this app's own `ratelimitState` table (schema.ts) -- unlike a
// Convex *component*, it needs no separate registration here.
const modules: Record<string, () => Promise<unknown>> = {
  './_generated/server.js': () => import('../_generated/server'),
  './routers/tts.ts': () => import('./tts'),
  './routers/ttsInternal.ts': () => import('./ttsInternal'),
  './lib/rateLimiter.ts': () => import('../../lib/rateLimiter'),
};

const originalFetch = global.fetch;
let fetchCalls: string[] = [];

afterEach(() => {
  global.fetch = originalFetch;
  fetchCalls = [];
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(url);
    return impl(url, init);
  }) as typeof fetch;
}

function fakeSonioxResponse(): Response {
  // Content doesn't need to be real MP3 bytes -- nothing in the test or the
  // action decodes it, it only needs to round-trip through `ctx.storage`.
  return new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });
}

function fakeGroqResponse(words: Array<{ word: string; start: number; end: number }>): Response {
  return new Response(JSON.stringify({ words }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function defaultProviderStub(words: Array<{ word: string; start: number; end: number }>) {
  stubFetch((url) => {
    if (url === 'https://tts-rt.soniox.com/tts') return fakeSonioxResponse();
    if (url === 'https://api.groq.com/openai/v1/audio/transcriptions') return fakeGroqResponse(words);
    throw new Error(`Unexpected live network call in test: ${url}`);
  });
}

// Drains the PER-CLIENT bucket for one clientId, directly against the same
// `ratelimitState` table convex/lib/rateLimiter.ts's `ttsClientRateLimiter`
// reads and writes -- exercises the real limiter (sliding window, 20/min,
// prefixed "tts-client"), just pre-loaded instead of hammered with 20 real
// calls.
async function drainClientRateLimit(t: ReturnType<typeof convexTest>, clientId: string) {
  await t.run(async (ctx) => {
    const limiter = new Ratelimit({
      db: ctx.db as any,
      limiter: Ratelimit.slidingWindow(20, MINUTE),
      prefix: 'tts-client',
    });
    await limiter.limit(clientId, { count: 20 });
  });
}

// Drains the GLOBAL bucket (fixed key, prefix "tts-global", 200/min) --
// this is the bucket a forged/rotating clientId cannot touch.
async function drainGlobalRateLimit(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const limiter = new Ratelimit({
      db: ctx.db as any,
      limiter: Ratelimit.slidingWindow(200, MINUTE),
      prefix: 'tts-global',
    });
    await limiter.limit(TTS_GLOBAL_KEY, { count: 200 });
  });
}

test('cache miss stores exactly one file and inserts exactly one audioTracks row', async () => {
  const t = convexTest(schema, modules);
  defaultProviderStub([
    { word: 'hello', start: 0, end: 0.3 },
    { word: 'world', start: 0.3, end: 0.6 },
  ]);

  const result = await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/cache-miss',
    title: 'Cache Miss Article',
    text: 'hello world',
    voice: 'Adrian',
    speed: 1,
    sonioxApiKey: 'fake-soniox-key',
    groqApiKey: 'fake-groq-key',
    clientId: 'client-a',
  });

  expect('audioUrl' in result && Boolean(result.audioUrl)).toBe(true);
  expect(result.provider).toBe('soniox');
  expect(result.cached).toBe(false);
  expect(fetchCalls).toEqual([
    'https://tts-rt.soniox.com/tts',
    'https://api.groq.com/openai/v1/audio/transcriptions',
  ]);

  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(tracks.length).toBe(1);
});

test('cache hit returns the stored audio, performs no provider fetch, and consumes neither rate limiter', async () => {
  const t = convexTest(schema, modules);
  defaultProviderStub([{ word: 'hi', start: 0, end: 0.2 }]);

  const first = await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/cache-hit',
    title: 'Cache Hit Article',
    text: 'hi',
    voice: 'Adrian',
    speed: 1,
    sonioxApiKey: 'fake-soniox-key',
    groqApiKey: 'fake-groq-key',
    clientId: 'client-b',
  });
  expect(first.cached).toBe(false);
  expect(fetchCalls.length).toBe(2);

  // Snapshot both limiters' remaining budget after the (single) cache-miss
  // request has already consumed one token from each.
  const remainingBefore = await t.run(async (ctx) => {
    const client = new Ratelimit({
      db: ctx.db as any,
      limiter: Ratelimit.slidingWindow(20, MINUTE),
      prefix: 'tts-client',
    });
    const global = new Ratelimit({
      db: ctx.db as any,
      limiter: Ratelimit.slidingWindow(200, MINUTE),
      prefix: 'tts-global',
    });
    return {
      client: (await client.getRemaining('client-b')).remaining,
      global: (await global.getRemaining(TTS_GLOBAL_KEY)).remaining,
    };
  });

  // Reset the call log, then repeat the identical request. This is the
  // assertion the plan calls out explicitly: a cache hit must not merely
  // return a usable response, it must call zero providers to get there.
  fetchCalls = [];
  // Fail loudly if the action calls fetch again -- a cache hit must not
  // reach either provider.
  stubFetch(() => {
    throw new Error('cache hit must not call any provider');
  });

  const second = await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/cache-hit',
    title: 'Cache Hit Article',
    text: 'hi',
    voice: 'Adrian',
    speed: 1,
    sonioxApiKey: 'fake-soniox-key',
    groqApiKey: 'fake-groq-key',
    clientId: 'client-b',
  });

  expect(second.cached).toBe(true);
  expect('audioUrl' in second && Boolean(second.audioUrl)).toBe(true);
  expect(fetchCalls).toEqual([]);

  // One stored file / one row for both requests combined, not two.
  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(tracks.length).toBe(1);

  // One `articles` row for both requests combined -- the cache hit did not
  // create (or need) a second one.
  const articlesAfterHit = await t.run(async (ctx) => ctx.db.query('articles').collect());
  expect(articlesAfterHit.length).toBe(1);

  // Neither limiter moved on the cache-hit request.
  const remainingAfter = await t.run(async (ctx) => {
    const client = new Ratelimit({
      db: ctx.db as any,
      limiter: Ratelimit.slidingWindow(20, MINUTE),
      prefix: 'tts-client',
    });
    const global = new Ratelimit({
      db: ctx.db as any,
      limiter: Ratelimit.slidingWindow(200, MINUTE),
      prefix: 'tts-global',
    });
    return {
      client: (await client.getRemaining('client-b')).remaining,
      global: (await global.getRemaining(TTS_GLOBAL_KEY)).remaining,
    };
  });
  expect(remainingAfter.client).toBe(remainingBefore.client);
  expect(remainingAfter.global).toBe(remainingBefore.global);
});

test('per-client rate-limit denial on a cache miss returns a client-usable browser-fallback result, not an error', async () => {
  const t = convexTest(schema, modules);
  // Drain the bucket for this client only (global bucket left untouched) --
  // this is the "honest client looping" case, not the forged-clientId
  // bypass (see the dedicated global-limiter test below).
  await drainClientRateLimit(t, 'client-drained');

  stubFetch(() => {
    throw new Error('a rate-limited request must never reach a provider');
  });

  const result = await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/rate-limited',
    title: 'Rate Limited Article',
    text: 'this request should be denied',
    voice: 'Adrian',
    speed: 1,
    sonioxApiKey: 'fake-soniox-key',
    groqApiKey: 'fake-groq-key',
    clientId: 'client-drained',
  });

  expect(result.provider).toBe('browser');
  expect(result.cached).toBe(false);
  expect('warning' in result ? result.warning : undefined).toContain('Rate limit');
  expect(result.words.length).toBeGreaterThan(0);
  expect(fetchCalls).toEqual([]);

  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(tracks.length).toBe(0);

  // Regression test for the write-before-gate bug a reviewer caught: the
  // article-stub write used to happen before the rate-limit check, so a
  // denied request still grew the `articles` table for free. It must not.
  //
  // Verified this is load-bearing, not a tautology: temporarily moved the
  // `getOrCreateArticleStub` call in convex/routers/tts.ts back above the
  // `consumeTtsRateLimit` call (its original position), re-ran this file,
  // watched this exact assertion fail (`articles.length` was 1, not 0 --
  // the denied request had already written a row), then restored the
  // reordered version and confirmed it passes again.
  const articles = await t.run(async (ctx) => ctx.db.query('articles').collect());
  expect(articles.length).toBe(0);
});

// Regression test for the bypass a reviewer caught: `clientId` is a plain
// procedure argument the caller controls (src/lib/storage.ts's
// getOrCreateClientId, a crypto.randomUUID() in localStorage). An attacker
// who mints a FRESH id on every request never touches the per-client
// bucket above -- only the global, caller-uninfluenced bucket can catch
// that. This test drains the global bucket and confirms a request with a
// clientId that has NEVER been used before is still denied.
//
// Verified this is a real regression test, not a tautology: temporarily
// removed the `ttsGlobalRateLimiter` call from
// convex/routers/ttsInternal.ts's consumeTtsRateLimit, re-ran this file,
// watched this test fail (the forged-id request went through to the
// provider stub instead of being denied), then restored the global check
// and confirmed it passes again.
test('the global limiter denies a request carrying a brand-new, never-before-seen clientId', async () => {
  const t = convexTest(schema, modules);
  await drainGlobalRateLimit(t);

  stubFetch(() => {
    throw new Error('a globally-rate-limited request must never reach a provider');
  });

  const freshClientId = `never-seen-before-${crypto.randomUUID()}`;
  const result = await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/global-limit',
    title: 'Global Limit Article',
    text: 'this request should be denied by the global bucket',
    voice: 'Adrian',
    speed: 1,
    sonioxApiKey: 'fake-soniox-key',
    groqApiKey: 'fake-groq-key',
    clientId: freshClientId,
  });

  expect(result.provider).toBe('browser');
  expect(result.cached).toBe(false);
  expect('warning' in result ? result.warning : undefined).toContain('Rate limit');
  expect(result.words.length).toBeGreaterThan(0);
  expect(fetchCalls).toEqual([]);

  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(tracks.length).toBe(0);

  // Same write-before-gate regression coverage as the per-client denial
  // test above: a globally-denied request must not have written an
  // `articles` row either.
  const articles = await t.run(async (ctx) => ctx.db.query('articles').collect());
  expect(articles.length).toBe(0);
});

test('a words array over 8192 entries is capped, not thrown', async () => {
  const t = convexTest(schema, modules);
  const hugeWordList = Array.from({ length: 9000 }, (_, i) => ({
    word: `w${i}`,
    start: i * 0.1,
    end: i * 0.1 + 0.05,
  }));
  defaultProviderStub(hugeWordList);

  const result = await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/huge-words',
    title: 'Huge Words Article',
    text: 'word '.repeat(500).trim(),
    voice: 'Adrian',
    speed: 1,
    sonioxApiKey: 'fake-soniox-key',
    groqApiKey: 'fake-groq-key',
    clientId: 'client-c',
  });

  expect(result.provider).toBe('soniox');
  expect(result.words.length).toBe(8192);
  expect('wordsTruncated' in result ? result.wordsTruncated : undefined).toBe(true);

  // The mutation must have actually succeeded (not thrown on the 1MB/8192
  // array ceiling) -- confirm the capped array made it into the row.
  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(tracks.length).toBe(1);
  expect(tracks[0]?.words.length).toBe(8192);
});

test('text over the 4000 character cap is rejected before any provider, rate-limit check, or write', async () => {
  const t = convexTest(schema, modules);
  stubFetch(() => {
    throw new Error('oversized text must never reach a provider');
  });

  const result = await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/too-long',
    title: 'Too Long Article',
    text: 'a'.repeat(50001),
    voice: 'Adrian',
    speed: 1,
    sonioxApiKey: 'fake-soniox-key',
    groqApiKey: 'fake-groq-key',
    clientId: 'client-d',
  });

  expect(result.provider).toBe('browser');
  expect(fetchCalls).toEqual([]);

  // The size check is pure input validation and must run before the
  // article-stub write -- a rejected request must not grow `articles`.
  const articles = await t.run(async (ctx) => ctx.db.query('articles').collect());
  expect(articles.length).toBe(0);
});

test('no Soniox key anywhere (input or env) uses the free browser path without consuming a rate-limit token', async () => {
  const t = convexTest(schema, modules);
  stubFetch(() => {
    throw new Error('a keyless request must never reach a provider');
  });

  const result = await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/no-key',
    title: 'No Key Article',
    text: 'hello there',
    voice: 'Adrian',
    speed: 1,
    clientId: 'client-e',
  });

  expect(result.provider).toBe('browser');
  expect(fetchCalls).toEqual([]);

  // Confirm no token was spent: draining the same client's budget to zero
  // and re-running the identical (keyless) request still succeeds via the
  // free path, because it never touches either limiter at all.
  await drainClientRateLimit(t, 'client-e');
  const second = await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/no-key',
    title: 'No Key Article',
    text: 'hello there',
    voice: 'Adrian',
    speed: 1,
    clientId: 'client-e',
  });
  expect(second.provider).toBe('browser');
});

test('internal.routers.ttsInternal.consumeTtsRateLimit is reachable through the internal api surface', () => {
  // Sanity check for the amendment's import rule: `internal` from
  // shared/api.ts's sibling `_generated/api` must resolve the plain
  // internalMutation this action's rate-limit step calls.
  expect(internal.routers.ttsInternal.consumeTtsRateLimit).toBeDefined();
});

async function withSonioxServerKey<T>(run: () => Promise<T>): Promise<T> {
  const originalKey = process.env.SONIOX_API_KEY;
  process.env.SONIOX_API_KEY = 'long-lived-soniox-key-that-must-never-leave-the-server';
  try {
    return await run();
  } finally {
    if (originalKey === undefined) {
      delete process.env.SONIOX_API_KEY;
    } else {
      process.env.SONIOX_API_KEY = originalKey;
    }
  }
}

test('temporaryKey posts the constrained Soniox request and returns only the temporary key', async () => {
  const t = convexTest(schema, modules);
  let request: RequestInit | undefined;

  await withSonioxServerKey(async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://api.soniox.com/v1/auth/temporary-api-key');
      request = init;
      return new Response(
        JSON.stringify({ api_key: 'temporary-soniox-key', expires_at: '2026-08-29T12:05:00.000Z' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await t.action(api.routers.tts.temporaryKey, { clientId: 'browser-client-123' });

    expect(result).toEqual({ apiKey: 'temporary-soniox-key', expiresAt: '2026-08-29T12:05:00.000Z' });
    expect(result.apiKey).not.toBe(process.env.SONIOX_API_KEY);
  });

  expect(request?.method).toBe('POST');
  expect(request?.headers).toMatchObject({
    Authorization: 'Bearer long-lived-soniox-key-that-must-never-leave-the-server',
    'Content-Type': 'application/json',
  });
  expect(JSON.parse(String(request?.body))).toEqual({
    usage_type: 'tts_rt',
    expires_in_seconds: 300,
    max_session_duration_seconds: 900,
    single_use: true,
    client_reference_id: 'browser-client-123',
  });
});

test('temporaryKey uses authenticated identity for Soniox attribution ahead of clientId', async () => {
  const t = convexTest(schema, modules);
  const authenticated = t.withIdentity({
    name: 'Key Owner',
    email: 'owner@example.com',
    tokenIdentifier: 'test|key-owner',
  });
  let clientReferenceId: string | undefined;

  await withSonioxServerKey(async () => {
    stubFetch((_url, init) => {
      clientReferenceId = JSON.parse(String(init?.body)).client_reference_id;
      return new Response(JSON.stringify({ api_key: 'temporary-key', expires_at: '2026-08-29T12:05:00.000Z' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await authenticated.action(api.routers.tts.temporaryKey, { clientId: 'forgeable-browser-client' });
  });

  expect(clientReferenceId).toBe('test|key-owner');
});

test('temporaryKey rejects the sixth request for one client before calling Soniox', async () => {
  const t = convexTest(schema, modules);

  await withSonioxServerKey(async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ api_key: 'temporary-key', expires_at: '2026-08-29T12:05:00.000Z' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    for (let request = 0; request < 5; request += 1) {
      await expect(t.action(api.routers.tts.temporaryKey, { clientId: 'key-burst-client' })).resolves.toEqual({
        apiKey: 'temporary-key',
        expiresAt: '2026-08-29T12:05:00.000Z',
      });
    }

    await expect(t.action(api.routers.tts.temporaryKey, { clientId: 'key-burst-client' })).rejects.toThrow(
      'Too many temporary key requests'
    );
  });

  expect(fetchCalls).toEqual([
    'https://api.soniox.com/v1/auth/temporary-api-key',
    'https://api.soniox.com/v1/auth/temporary-api-key',
    'https://api.soniox.com/v1/auth/temporary-api-key',
    'https://api.soniox.com/v1/auth/temporary-api-key',
    'https://api.soniox.com/v1/auth/temporary-api-key',
  ]);
});

test('temporaryKey fails clearly without a server key or a valid Soniox response', async () => {
  const t = convexTest(schema, modules);
  const originalKey = process.env.SONIOX_API_KEY;
  delete process.env.SONIOX_API_KEY;

  try {
    stubFetch(() => {
      throw new Error('missing server key must not call Soniox');
    });
    await expect(t.action(api.routers.tts.temporaryKey, {})).rejects.toThrow('SONIOX_API_KEY is not configured');
    expect(fetchCalls).toEqual([]);
  } finally {
    if (originalKey === undefined) {
      delete process.env.SONIOX_API_KEY;
    } else {
      process.env.SONIOX_API_KEY = originalKey;
    }
  }

  await withSonioxServerKey(async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ expires_at: '2026-08-29T12:05:00.000Z' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(t.action(api.routers.tts.temporaryKey, { clientId: 'malformed-response-client' })).rejects.toThrow(
      'Soniox returned an invalid temporary key response'
    );
  });
});
