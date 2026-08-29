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

async function drainTrackUploadRateLimit(t: ReturnType<typeof convexTest>, clientId: string) {
  await t.run(async (ctx) => {
    const limiter = new Ratelimit({
      db: ctx.db as any,
      limiter: Ratelimit.slidingWindow(5, MINUTE),
      prefix: 'tts-temporary-key-client',
    });
    await limiter.limit(clientId, { count: 5 });
  });
}

const exactWords = [
  { text: 'Exact', start: 0.1, end: 0.35 },
  { text: 'timing', start: 0.4, end: 0.7 },
];

async function storeUploadedTestAudio(t: ReturnType<typeof convexTest>, bytes: number[]) {
  const storageId = await t.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }))
  );
  // convex-test's direct storage helper omits contentType, while the real
  // browser upload endpoint records the POST's Content-Type header. Patch the
  // emulator system row so successful fixtures mirror the production upload.
  await t.run(async (ctx) => {
    await (ctx.db as any).patch(storageId, { contentType: 'audio/mpeg' });
  });
  return storageId;
}

async function issueTrackUploadGrant(t: ReturnType<typeof convexTest>, clientId: string) {
  return (await t.mutation(api.routers.tts.generateTrackUploadUrl, { clientId })) as {
    uploadUrl: string;
    grant: string;
    expiresAt: number;
  };
}

async function exactPersistenceWrites(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    articles: await ctx.db.query('articles').collect(),
    tracks: await ctx.db.query('audioTracks').collect(),
  }));
}

test('exact cache lookup rejects legacy, estimated, truncated, and missing-storage tracks', async () => {
  const t = convexTest(schema, modules);
  const storageId = await storeUploadedTestAudio(t, [1, 2, 3]);
  const { articleId, trackId } = await t.run(async (ctx) => {
    const articleId = await ctx.db.insert('articles', {
      url: 'https://example.com/provenance',
      title: 'Provenance',
      content: 'Exact timing',
      author: 'Author',
      sourceType: 'article',
      wordCount: 2,
      createdAt: 1,
    });
    const trackId = await ctx.db.insert('audioTracks', {
      articleId,
      voice: 'Adrian',
      speed: 1,
      storageId,
      duration: 0.7,
      words: exactWords,
      createdAt: 1,
    });
    return { articleId, trackId };
  });

  const getExactTrack = api.routers.tts.getExactTrack;
  expect(
    await t.query(getExactTrack, {
      url: 'https://example.com/provenance',
      voice: 'Adrian',
    })
  ).toBeNull();

  await t.run(async (ctx) => ctx.db.patch(trackId, { timingsSource: 'estimated' }));
  expect(
    await t.query(getExactTrack, {
      url: 'https://example.com/provenance',
      voice: 'Adrian',
    })
  ).toBeNull();

  await t.run(async (ctx) =>
    ctx.db.patch(trackId, {
      timingsSource: 'soniox',
      words: exactWords.slice(0, 1),
    })
  );
  expect(
    await t.query(getExactTrack, {
      url: 'https://example.com/provenance',
      voice: 'Adrian',
    })
  ).toBeNull();

  await t.run(async (ctx) => ctx.db.patch(trackId, { words: exactWords }));
  const hit = await t.query(getExactTrack, {
    url: 'https://example.com/provenance',
    voice: 'Adrian',
  });
  expect(hit).toMatchObject({ words: exactWords, duration: 0.7 });
  expect(hit?.audioUrl).toStartWith('https://some-deployment.convex.cloud/api/storage/');

  await t.run(async (ctx) => ctx.storage.delete(storageId));
  expect(
    await t.query(getExactTrack, {
      url: 'https://example.com/provenance',
      voice: 'Adrian',
    })
  ).toBeNull();

  expect(articleId).toBeTruthy();
});

test('track upload URL issuance is denied by the existing limiter before returning a URL', async () => {
  const t = convexTest(schema, modules);
  await drainTrackUploadRateLimit(t, 'upload-drained');

  await expect(
    t.mutation(api.routers.tts.generateTrackUploadUrl, {
      clientId: 'upload-drained',
    })
  ).rejects.toThrow('Too many track upload requests');

  const articles = await t.run(async (ctx) => ctx.db.query('articles').collect());
  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(articles).toEqual([]);
  expect(tracks).toEqual([]);
});

test('track upload issuance returns distinct 256-bit capabilities with bounded expiry', async () => {
  const t = convexTest(schema, modules);
  const issuedAfter = Date.now();
  const first = await issueTrackUploadGrant(t, 'capability-first');
  const second = await issueTrackUploadGrant(t, 'capability-second');

  expect(first.grant).toMatch(/^[0-9a-f]{64}$/);
  expect(second.grant).toMatch(/^[0-9a-f]{64}$/);
  expect(second.grant).not.toBe(first.grant);
  expect(first.expiresAt).toBeGreaterThan(issuedAfter);
  expect(first.expiresAt).toBeLessThanOrEqual(issuedAfter + 10 * 60 * 1000);

  const grants = await t.run(async (ctx) => ctx.db.query('ttsUploadGrants').collect());
  expect(grants.map((grant) => grant.token).sort()).toEqual([first.grant, second.grant].sort());
});

test('successful issuance removes at most 32 expired grants and preserves every live grant', async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  await t.run(async (ctx) => {
    for (let index = 0; index < 35; index += 1) {
      await ctx.db.insert('ttsUploadGrants', {
        token: `expired-grant-${index}`,
        expiresAt: now - 1,
        createdAt: now - 60_000,
      });
    }
    await ctx.db.insert('ttsUploadGrants', {
      token: 'live-grant-a',
      expiresAt: now + 60_000,
      createdAt: now,
    });
    await ctx.db.insert('ttsUploadGrants', {
      token: 'live-grant-b',
      expiresAt: now + 120_000,
      createdAt: now,
    });
  });

  const issued = await issueTrackUploadGrant(t, 'cleanup-issuer');
  const grants = await t.run(async (ctx) => ctx.db.query('ttsUploadGrants').collect());
  const expired = grants.filter((grant) => grant.expiresAt <= now);
  const liveTokens = grants
    .filter((grant) => grant.expiresAt > now)
    .map((grant) => grant.token);

  expect(expired).toHaveLength(3);
  expect(liveTokens).toContain('live-grant-a');
  expect(liveTokens).toContain('live-grant-b');
  expect(liveTokens).toContain(issued.grant);
  expect(issued.uploadUrl).toStartWith('https://some-deployment.convex.cloud/api/storage/');
});

test('track upload allocation is unreachable when capability issuance is rate denied', async () => {
  const ttsModule = await import('./tts');
  let allocationCalls = 0;

  await expect(
    ttsModule.allocateTrackUploadAfterGrant(
      async () => ({ ok: false as const }),
      async () => {
        allocationCalls += 1;
        return 'https://must-not-be-allocated.example';
      }
    )
  ).rejects.toThrow('Too many track upload requests');

  expect(allocationCalls).toBe(0);
});

test('exact track finalization requires a valid unexpired upload grant before writing', async () => {
  const baseInput = {
    url: 'https://example.com/grant-required',
    text: 'Exact timing',
    voice: 'Adrian',
    duration: 0.7,
    words: exactWords,
  };

  for (const variant of ['missing', 'wrong', 'expired'] as const) {
    const t = convexTest(schema, modules);
    const storageId = await storeUploadedTestAudio(t, [1, 2, 3]);
    const input: Record<string, unknown> = { ...baseInput, storageId };
    if (variant === 'wrong') input.grant = `wrong-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    if (variant === 'expired') {
      const grant = `expired-${crypto.randomUUID()}-${crypto.randomUUID()}`;
      input.grant = grant;
      await t.run(async (ctx) => {
        await (ctx.db as any).insert('ttsUploadGrants', {
          token: grant,
          expiresAt: Date.now() - 1,
          createdAt: Date.now() - 60_000,
        });
      });
    }

    await expect(t.mutation(api.routers.tts.persistTrack, input as any)).rejects.toThrow(
      variant === 'expired' ? /expired/i : /grant/i
    );
    expect(await exactPersistenceWrites(t)).toEqual({ articles: [], tracks: [] });
  }
});

test('an upload grant is single-use and a storage ID cannot be finalized into multiple rows', async () => {
  const t = convexTest(schema, modules);
  const storageId = await storeUploadedTestAudio(t, [1, 2, 3]);
  const firstGrant = await issueTrackUploadGrant(t, 'single-use-first');
  const baseInput = {
    text: 'Exact timing',
    voice: 'Adrian',
    storageId,
    duration: 0.7,
    words: exactWords,
  };

  await t.mutation(api.routers.tts.persistTrack, {
    ...baseInput,
    url: 'https://example.com/grant-first',
    grant: firstGrant.grant,
  });

  await expect(
    t.mutation(api.routers.tts.persistTrack, {
      ...baseInput,
      url: 'https://example.com/reused-grant',
      grant: firstGrant.grant,
    })
  ).rejects.toThrow(/grant/i);

  const secondGrant = await issueTrackUploadGrant(t, 'single-use-second');
  await expect(
    t.mutation(api.routers.tts.persistTrack, {
      ...baseInput,
      url: 'https://example.com/reused-storage',
      grant: secondGrant.grant,
    })
  ).rejects.toThrow(/storageId.*already/i);

  const writes = await exactPersistenceWrites(t);
  expect(writes.articles).toHaveLength(1);
  expect(writes.tracks).toHaveLength(1);
});

test('exact track finalization upserts at speed 1 and deletes the superseded stored audio', async () => {
  const t = convexTest(schema, modules);
  const firstStorageId = await storeUploadedTestAudio(t, [1]);
  const replacementStorageId = await storeUploadedTestAudio(t, [2, 3]);
  const persistTrack = api.routers.tts.persistTrack;
  const input = {
    url: 'https://example.com/upsert',
    title: 'Exact Track',
    author: 'Author',
    text: 'Exact timing',
    voice: 'Adrian',
    duration: 0.7,
    words: exactWords,
  };

  const firstGrant = await issueTrackUploadGrant(t, 'upsert-first');
  const replacementGrant = await issueTrackUploadGrant(t, 'upsert-replacement');
  const first = await t.mutation(persistTrack, {
    ...input,
    storageId: firstStorageId,
    grant: firstGrant.grant,
  });
  const replacement = await t.mutation(persistTrack, {
    ...input,
    storageId: replacementStorageId,
    grant: replacementGrant.grant,
    duration: 0.8,
    words: [
      { text: 'Exact', start: 0.15, end: 0.4 },
      { text: 'timing', start: 0.45, end: 0.8 },
    ],
  });

  expect(replacement.articleId).toBe(first.articleId);
  expect(replacement.trackId).toBe(first.trackId);

  const { articles, tracks, firstStorage, replacementStorage } = await t.run(async (ctx) => ({
    articles: await ctx.db.query('articles').collect(),
    tracks: await ctx.db.query('audioTracks').collect(),
    firstStorage: await ctx.db.system.get('_storage', firstStorageId),
    replacementStorage: await ctx.db.system.get('_storage', replacementStorageId),
  }));
  expect(articles).toHaveLength(1);
  expect(tracks).toHaveLength(1);
  expect(tracks[0]).toMatchObject({
    speed: 1,
    storageId: replacementStorageId,
    duration: 0.8,
    timingsSource: 'soniox',
  });
  expect(firstStorage).toBeNull();
  expect(replacementStorage?.size).toBe(2);
});

test('replacing one of two shared storage references leaves the old blob alive', async () => {
  const t = convexTest(schema, modules);
  const sharedStorageId = await storeUploadedTestAudio(t, [1]);
  const replacementStorageId = await storeUploadedTestAudio(t, [2]);
  const { primaryArticleId } = await t.run(async (ctx) => {
    const primaryArticleId = await ctx.db.insert('articles', {
      url: 'https://example.com/shared-primary',
      title: 'Primary',
      content: 'Exact timing',
      author: 'Author',
      sourceType: 'article',
      wordCount: 2,
      createdAt: 1,
    });
    const secondaryArticleId = await ctx.db.insert('articles', {
      url: 'https://example.com/shared-secondary',
      title: 'Secondary',
      content: 'Exact timing',
      author: 'Author',
      sourceType: 'article',
      wordCount: 2,
      createdAt: 1,
    });
    await ctx.db.insert('audioTracks', {
      articleId: primaryArticleId,
      voice: 'Adrian',
      speed: 1,
      storageId: sharedStorageId,
      duration: 0.7,
      timingsSource: 'soniox',
      words: exactWords,
      createdAt: 1,
    });
    await ctx.db.insert('audioTracks', {
      articleId: secondaryArticleId,
      voice: 'Adrian',
      speed: 1,
      storageId: sharedStorageId,
      duration: 0.7,
      timingsSource: 'soniox',
      words: exactWords,
      createdAt: 1,
    });
    return { primaryArticleId };
  });
  const grant = await issueTrackUploadGrant(t, 'shared-storage-replacement');

  const result = await t.mutation(api.routers.tts.persistTrack, {
    url: 'https://example.com/shared-primary',
    text: 'Exact timing',
    voice: 'Adrian',
    storageId: replacementStorageId,
    grant: grant.grant,
    duration: 0.7,
    words: exactWords,
  });

  expect(result.articleId).toBe(primaryArticleId);
  const { sharedStorage, references } = await t.run(async (ctx) => ({
    sharedStorage: await ctx.db.system.get('_storage', sharedStorageId),
    references: (await ctx.db.query('audioTracks').collect()).filter(
      (track) => track.storageId === sharedStorageId
    ),
  }));
  expect(references).toHaveLength(1);
  expect(sharedStorage?.size).toBe(1);
});

test('exact track finalization rejects values that are not uploaded audio storage IDs', async () => {
  const t = convexTest(schema, modules);
  const grant = await issueTrackUploadGrant(t, 'not-storage');
  const articleId = await t.run(async (ctx) =>
    ctx.db.insert('articles', {
      url: 'https://example.com/not-storage',
      title: 'Not storage',
      content: 'Exact timing',
      author: 'Author',
      sourceType: 'article',
      wordCount: 2,
      createdAt: 1,
    })
  );

  await expect(
    t.mutation(api.routers.tts.persistTrack, {
      url: 'https://example.com/not-storage',
      text: 'Exact timing',
      voice: 'Adrian',
      storageId: articleId,
      grant: grant.grant,
      duration: 0.7,
      words: exactWords,
    })
  ).rejects.toThrow(/ArgumentValidationError|storage/i);

  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(tracks).toEqual([]);
});

test('exact track finalization rejects uploaded storage without the required audio MIME type', async () => {
  const t = convexTest(schema, modules);
  const grant = await issueTrackUploadGrant(t, 'missing-mime');
  const storageIdWithoutMime = await t.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])]))
  );

  await expect(
    t.mutation(api.routers.tts.persistTrack, {
      url: 'https://example.com/missing-mime',
      text: 'Exact timing',
      voice: 'Adrian',
      storageId: storageIdWithoutMime,
      grant: grant.grant,
      duration: 0.7,
      words: exactWords,
    })
  ).rejects.toThrow('audio/mpeg');

  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(tracks).toEqual([]);
});

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

test('REST synthesis keeps its legacy 900-character fallback cap while WebSocket chunking stays uncapped', async () => {
  const t = convexTest(schema, modules);
  const sonioxTexts: string[] = [];
  stubFetch((url, init) => {
    if (url === 'https://tts-rt.soniox.com/tts') {
      sonioxTexts.push(JSON.parse(String(init?.body)).text);
      return fakeSonioxResponse();
    }
    throw new Error(`Unexpected live network call in test: ${url}`);
  });

  const text = 'x '.repeat(500).trim();
  await t.action(api.routers.tts.synthesize, {
    url: 'https://example.com/rest-fallback-cap',
    title: 'REST fallback cap',
    text,
    voice: 'Adrian',
    speed: 1,
    sonioxApiKey: 'fake-soniox-key',
    clientId: 'client-rest-cap',
  });

  expect(sonioxTexts.join(' ').length).toBeLessThanOrEqual(900);
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

test('temporaryKey global-limit denial prevents its Soniox fetch', async () => {
  const t = convexTest(schema, modules);
  await drainGlobalRateLimit(t);

  await withSonioxServerKey(async () => {
    stubFetch(() => {
      throw new Error('a globally rate-limited temporary-key request must not reach Soniox');
    });

    await expect(t.action(api.routers.tts.temporaryKey, { clientId: 'new-client-after-global-limit' })).rejects.toThrow(
      'Too many temporary key requests'
    );
  });

  expect(fetchCalls).toEqual([]);
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
