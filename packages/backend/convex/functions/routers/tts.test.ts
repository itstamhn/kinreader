import { test, expect, afterEach } from 'bun:test';
import { convexTest } from 'convex-test';
import { MINUTE, Ratelimit } from 'kitcn/ratelimit';
// kitcn's generated `api` surface is the type-complete one for cRPC
// procedures -- Convex's own `_generated/api.d.ts` type filters kitcn's
// wrapped `Procedure` out of `api.routers` entirely (see
// convex/routers/articles.test.ts for the full explanation).
import { api } from '../../shared/api';
import { internal } from '../_generated/api';
import { GLOBAL_TRACK_OWNER_KEY } from './ttsInternal';
import type { Id } from '../_generated/dataModel';
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
  // `tts.pregenerate` schedules this Node action; convex-test runs scheduled
  // functions on a real timer, so the module has to be resolvable. With no
  // SONIOX_API_KEY in the test environment it records a failed job and stops
  // before touching the network.
  './routers/pregenerate.ts': () => import('./pregenerate'),
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

const EXACT_CACHE_KEY =
  'content-sha256:b2d0149d4df84e1408ed3208160aa121666399f06ebc62f7636aaeac1d329fb6';
const EXACT_CONTENT_DIGEST = 'b2d0149d4df84e1408ed3208160aa121666399f06ebc62f7636aaeac1d329fb6';
const ALICE_IDENTITY = {
  name: 'Alice',
  email: 'alice@example.com',
  tokenIdentifier: 'test|alice',
};
const BOB_IDENTITY = {
  name: 'Bob',
  email: 'bob@example.com',
  tokenIdentifier: 'test|bob',
};

const exactGrantBindings = {
  cacheKey: EXACT_CACHE_KEY,
  contentDigest: EXACT_CONTENT_DIGEST,
  voice: 'Adrian',
};

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

function trackUploadContentType(grant: string, baseType = 'audio/mpeg') {
  return `${baseType}; kinreader-grant=${grant}`;
}

async function storeBoundTrackUpload(
  t: ReturnType<typeof convexTest>,
  grant: string,
  bytes: Uint8Array,
  baseType = 'audio/mpeg'
) {
  const uploadBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(uploadBytes).set(bytes);
  const storageId = await t.run(async (ctx) =>
    ctx.storage.store(new Blob([uploadBytes], { type: trackUploadContentType(grant, baseType) }))
  );
  await t.run(async (ctx) => {
    await (ctx.db as any).patch(storageId, {
      contentType: trackUploadContentType(grant, baseType),
    });
  });
  return storageId;
}

async function issueTrackUploadGrant(
  t: ReturnType<typeof convexTest>,
  bindings: typeof exactGrantBindings = exactGrantBindings
) {
  return (await t.withIdentity(ALICE_IDENTITY).mutation(
    api.routers.tts.generateTrackUploadUrl,
    bindings
  )) as {
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

test('anonymous callers cannot read, upload, or finalize server exact-cache artifacts', async () => {
  const t = convexTest(schema, modules);
  const storageId = await storeUploadedTestAudio(t, [1, 2, 3]);
  await t.run(async (ctx) => {
    const articleId = await ctx.db.insert('articles', {
      url: EXACT_CACHE_KEY,
      title: 'Legacy global exact cache',
      content: 'Exact timing',
      author: 'Unknown',
      sourceType: 'text',
      wordCount: 2,
      createdAt: 1,
    });
    await ctx.db.insert('audioTracks', {
      articleId,
      voice: 'Adrian',
      speed: 1,
      storageId,
      duration: 0.7,
      timingsSource: 'soniox',
      words: exactWords,
      createdAt: 1,
    });
  });

  expect(
    await t.query(api.routers.tts.getExactTrack, {
      url: EXACT_CACHE_KEY,
      voice: 'Adrian',
    })
  ).toBeNull();
  await expect(
    t.mutation(api.routers.tts.generateTrackUploadUrl, exactGrantBindings as any)
  ).rejects.toThrow(/sign in|authenticated/i);
  await expect(
    t.mutation(api.routers.tts.persistTrack, {
      url: EXACT_CACHE_KEY,
      text: 'Exact timing',
      voice: 'Adrian',
      grant: `${crypto.randomUUID()}${crypto.randomUUID()}`,
      storageId,
      duration: 0.7,
      words: exactWords,
    })
  ).rejects.toThrow(/sign in|authenticated/i);
});

test("Bob cannot finalize Alice's owner-bound upload grant", async () => {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE_IDENTITY);
  const bob = t.withIdentity(BOB_IDENTITY);
  const issued = (await alice.mutation(
    api.routers.tts.generateTrackUploadUrl,
    exactGrantBindings as any
  )) as { grant: string };
  const storageId = await storeBoundTrackUpload(t, issued.grant, new Uint8Array([4, 5, 6]));

  const result = await bob.mutation(api.routers.tts.persistTrack, {
    url: EXACT_CACHE_KEY,
    text: 'Exact timing',
    voice: 'Adrian',
    grant: issued.grant,
    storageId,
    duration: 0.7,
    words: exactWords,
  });
  expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/grant|owner/i) });

  expect(await exactPersistenceWrites(t)).toEqual({ articles: [], tracks: [] });
});

test("Alice's exact artifact cannot hit or poison Bob's owner-scoped cache", async () => {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE_IDENTITY);
  const bob = t.withIdentity(BOB_IDENTITY);
  const aliceGrant = (await alice.mutation(
    api.routers.tts.generateTrackUploadUrl,
    exactGrantBindings as any
  )) as { grant: string };
  const aliceStorageId = await storeBoundTrackUpload(
    t,
    aliceGrant.grant,
    new Uint8Array([1, 2, 3])
  );

  expect(await alice.mutation(api.routers.tts.persistTrack, {
    url: EXACT_CACHE_KEY,
    text: 'Exact timing',
    voice: 'Adrian',
    grant: aliceGrant.grant,
    storageId: aliceStorageId,
    duration: 0.7,
    words: exactWords,
  })).toMatchObject({ ok: true });

  expect(
    await bob.query(api.routers.tts.getExactTrack, { url: EXACT_CACHE_KEY, voice: 'Adrian' })
  ).toBeNull();
  expect(
    await alice.query(api.routers.tts.getExactTrack, { url: EXACT_CACHE_KEY, voice: 'Adrian' })
  ).toMatchObject({ words: exactWords });

  const bobGrant = (await bob.mutation(
    api.routers.tts.generateTrackUploadUrl,
    exactGrantBindings as any
  )) as { grant: string };
  const bobStorageId = await storeBoundTrackUpload(
    t,
    bobGrant.grant,
    new Uint8Array([7, 8, 9])
  );
  expect(await bob.mutation(api.routers.tts.persistTrack, {
    url: EXACT_CACHE_KEY,
    text: 'Exact timing',
    voice: 'Adrian',
    grant: bobGrant.grant,
    storageId: bobStorageId,
    duration: 0.7,
    words: exactWords,
  })).toMatchObject({ ok: true });

  const writes = await exactPersistenceWrites(t);
  expect(writes.articles).toHaveLength(2);
  expect(writes.tracks).toHaveLength(2);
  expect(
    await alice.query(api.routers.tts.getExactTrack, { url: EXACT_CACHE_KEY, voice: 'Adrian' })
  ).toMatchObject({ words: exactWords });
});

test('exact cache lookup rejects legacy, estimated, truncated, and missing-storage tracks', async () => {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE_IDENTITY);
  const grant = await issueTrackUploadGrant(t);
  const storageId = await storeBoundTrackUpload(t, grant.grant, new Uint8Array([1, 2, 3]));
  const persisted = await alice.mutation(api.routers.tts.persistTrack, {
    url: EXACT_CACHE_KEY,
    text: 'Exact timing',
    voice: 'Adrian',
    storageId,
    grant: grant.grant,
    duration: 0.7,
    words: exactWords,
  });
  expect(persisted).toMatchObject({ ok: true });
  const trackId = persisted.ok ? (persisted.trackId as Id<'audioTracks'>) : null;
  if (!trackId) throw new Error('Expected exact track persistence to succeed');

  const getExactTrack = api.routers.tts.getExactTrack;
  await t.run(async (ctx) => ctx.db.patch(trackId, { timingsSource: undefined }));
  expect(
    await alice.query(getExactTrack, {
      url: EXACT_CACHE_KEY,
      voice: 'Adrian',
    })
  ).toBeNull();

  await t.run(async (ctx) => ctx.db.patch(trackId, { timingsSource: 'estimated' }));
  expect(
    await alice.query(getExactTrack, {
      url: EXACT_CACHE_KEY,
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
    await alice.query(getExactTrack, {
      url: EXACT_CACHE_KEY,
      voice: 'Adrian',
    })
  ).toBeNull();

  await t.run(async (ctx) => ctx.db.patch(trackId, { words: exactWords }));
  const hit = await alice.query(getExactTrack, {
    url: EXACT_CACHE_KEY,
    voice: 'Adrian',
  });
  expect(hit).toMatchObject({ words: exactWords, duration: 0.7 });
  expect(hit?.audioUrl).toStartWith('https://some-deployment.convex.cloud/api/storage/');

  await t.run(async (ctx) => ctx.storage.delete(storageId));
  expect(
    await alice.query(getExactTrack, {
      url: EXACT_CACHE_KEY,
      voice: 'Adrian',
    })
  ).toBeNull();

});

test('track upload URL issuance is denied by the existing limiter before returning a URL', async () => {
  const t = convexTest(schema, modules);
  await drainTrackUploadRateLimit(t, 'upload-drained');
  const drainedOwner = t.withIdentity({
    name: 'Drained',
    email: 'drained@example.com',
    tokenIdentifier: 'upload-drained',
  });

  await expect(
    drainedOwner.mutation(api.routers.tts.generateTrackUploadUrl, exactGrantBindings)
  ).rejects.toThrow('Too many track upload requests');

  const articles = await t.run(async (ctx) => ctx.db.query('articles').collect());
  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(articles).toEqual([]);
  expect(tracks).toEqual([]);
});

test('track upload issuance returns distinct 256-bit capabilities with bounded expiry', async () => {
  const t = convexTest(schema, modules);
  const issuedAfter = Date.now();
  const first = await issueTrackUploadGrant(t);
  const firstCompletedAt = Date.now();
  const second = await issueTrackUploadGrant(t);

  expect(first.grant).toMatch(/^[0-9a-f]{64}$/);
  expect(second.grant).toMatch(/^[0-9a-f]{64}$/);
  expect(second.grant).not.toBe(first.grant);
  expect(first.expiresAt).toBeGreaterThan(issuedAfter);
  expect(first.expiresAt).toBeLessThanOrEqual(firstCompletedAt + 10 * 60 * 1000);

  const grants = await t.run(async (ctx) => ctx.db.query('ttsExactUploadGrants').collect());
  expect(grants.map((grant) => grant.token).sort()).toEqual([first.grant, second.grant].sort());
});

test('successful issuance removes at most 32 expired grants and preserves every live grant', async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  await t.run(async (ctx) => {
    for (let index = 0; index < 35; index += 1) {
      await ctx.db.insert('ttsExactUploadGrants', {
        token: `expired-grant-${index}`,
        ownerKey: ALICE_IDENTITY.tokenIdentifier,
        cacheKey: EXACT_CACHE_KEY,
        contentDigest: EXACT_CONTENT_DIGEST,
        voice: 'Adrian',
        expiresAt: now - 1,
        createdAt: now - 60_000,
      });
    }
    await ctx.db.insert('ttsExactUploadGrants', {
      token: 'live-grant-a',
      ownerKey: ALICE_IDENTITY.tokenIdentifier,
      cacheKey: EXACT_CACHE_KEY,
      contentDigest: EXACT_CONTENT_DIGEST,
      voice: 'Adrian',
      expiresAt: now + 60_000,
      createdAt: now,
    });
    await ctx.db.insert('ttsExactUploadGrants', {
      token: 'live-grant-b',
      ownerKey: ALICE_IDENTITY.tokenIdentifier,
      cacheKey: EXACT_CACHE_KEY,
      contentDigest: EXACT_CONTENT_DIGEST,
      voice: 'Adrian',
      expiresAt: now + 120_000,
      createdAt: now,
    });
  });

  const issued = await issueTrackUploadGrant(t);
  const grants = await t.run(async (ctx) => ctx.db.query('ttsExactUploadGrants').collect());
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
    url: EXACT_CACHE_KEY,
    text: 'Exact timing',
    voice: 'Adrian',
    duration: 0.7,
    words: exactWords,
  };

  for (const variant of ['missing', 'wrong', 'expired'] as const) {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity(ALICE_IDENTITY);
    const token = variant === 'wrong' ? 'f'.repeat(64) : variant === 'expired' ? 'e'.repeat(64) : null;
    const storageId = token
      ? await storeBoundTrackUpload(t, token, new Uint8Array([1, 2, 3]))
      : await storeUploadedTestAudio(t, [1, 2, 3]);
    const input: Record<string, unknown> = { ...baseInput, storageId };
    if (token) input.grant = token;
    if (variant === 'expired') {
      await t.run(async (ctx) => {
        await ctx.db.insert('ttsExactUploadGrants', {
          token: token!,
          ownerKey: ALICE_IDENTITY.tokenIdentifier,
          cacheKey: EXACT_CACHE_KEY,
          contentDigest: EXACT_CONTENT_DIGEST,
          voice: 'Adrian',
          expiresAt: Date.now() - 1,
          createdAt: Date.now() - 60_000,
        });
      });
    }

    if (variant === 'missing') {
      await expect(alice.mutation(api.routers.tts.persistTrack, input as any)).rejects.toThrow(/grant/i);
    } else {
      const result = await alice.mutation(api.routers.tts.persistTrack, input as any);
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(variant === 'expired' ? /expired/i : /grant/i),
      });
    }
    expect(await exactPersistenceWrites(t)).toEqual({ articles: [], tracks: [] });
  }
});

test('an upload grant is single-use and a storage ID cannot be finalized into multiple rows', async () => {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE_IDENTITY);
  const firstGrant = await issueTrackUploadGrant(t);
  const storageId = await storeBoundTrackUpload(t, firstGrant.grant, new Uint8Array([1, 2, 3]));
  const baseInput = {
    url: EXACT_CACHE_KEY,
    text: 'Exact timing',
    voice: 'Adrian',
    storageId,
    duration: 0.7,
    words: exactWords,
  };

  expect(
    await alice.mutation(api.routers.tts.persistTrack, {
      ...baseInput,
      grant: firstGrant.grant,
    })
  ).toMatchObject({ ok: true });

  expect(
    await alice.mutation(api.routers.tts.persistTrack, {
      ...baseInput,
      grant: firstGrant.grant,
    })
  ).toMatchObject({ ok: false, error: expect.stringMatching(/grant/i) });

  const secondGrant = await issueTrackUploadGrant(t);
  await t.run(async (ctx) => {
    await (ctx.db as any).patch(storageId, {
      contentType: trackUploadContentType(secondGrant.grant),
    });
  });
  expect(
    await alice.mutation(api.routers.tts.persistTrack, {
      ...baseInput,
      grant: secondGrant.grant,
    })
  ).toMatchObject({ ok: false, error: expect.stringMatching(/storageId.*already/i) });

  const writes = await exactPersistenceWrites(t);
  expect(writes.articles).toHaveLength(1);
  expect(writes.tracks).toHaveLength(1);
});

test('exact track finalization upserts at speed 1 and deletes the superseded stored audio', async () => {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE_IDENTITY);
  const persistTrack = api.routers.tts.persistTrack;
  const input = {
    url: EXACT_CACHE_KEY,
    title: 'Exact Track',
    author: 'Author',
    text: 'Exact timing',
    voice: 'Adrian',
    duration: 0.7,
    words: exactWords,
  };

  const firstGrant = await issueTrackUploadGrant(t);
  const replacementGrant = await issueTrackUploadGrant(t);
  const firstStorageId = await storeBoundTrackUpload(t, firstGrant.grant, new Uint8Array([1]));
  const replacementStorageId = await storeBoundTrackUpload(
    t,
    replacementGrant.grant,
    new Uint8Array([2, 3])
  );
  const first = await alice.mutation(persistTrack, {
    ...input,
    storageId: firstStorageId,
    grant: firstGrant.grant,
  });
  const replacement = await alice.mutation(persistTrack, {
    ...input,
    storageId: replacementStorageId,
    grant: replacementGrant.grant,
    duration: 0.8,
    words: [
      { text: 'Exact', start: 0.15, end: 0.4 },
      { text: 'timing', start: 0.45, end: 0.8 },
    ],
  });

  expect(first.ok).toBe(true);
  expect(replacement.ok).toBe(true);
  if (!first.ok || !replacement.ok) throw new Error('Expected successful exact-track upsert');
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

test('replacing a legacy unclaimed storage reference does not delete a possibly shared blob', async () => {
  const t = convexTest(schema, modules);
  const sharedStorageId = await storeUploadedTestAudio(t, [1]);
  const replacementStorageId = await storeUploadedTestAudio(t, [2]);
  const { primaryArticleId, primaryTrackId } = await t.run(async (ctx) => {
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
    const primaryTrackId = await ctx.db.insert('audioTracks', {
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
    return { primaryArticleId, primaryTrackId };
  });

  const result = await t.mutation(internal.routers.ttsInternal.insertAudioTrack, {
    articleId: primaryArticleId,
    voice: 'Adrian',
    speed: 1,
    storageId: replacementStorageId,
    duration: 0.7,
    timingsSource: 'estimated',
    words: exactWords,
  });

  expect(result).toBe(primaryTrackId);
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
  const alice = t.withIdentity(ALICE_IDENTITY);
  const grant = await issueTrackUploadGrant(t);
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

  const result = await alice.mutation(api.routers.tts.persistTrack, {
    url: EXACT_CACHE_KEY,
    text: 'Exact timing',
    voice: 'Adrian',
    storageId: articleId,
    grant: grant.grant,
    duration: 0.7,
    words: exactWords,
  });
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringMatching(/ArgumentValidationError|storage/i),
  });

  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(tracks).toEqual([]);
});

test('an unmarked invalid upload is rejected but retained because ownership cannot be proven safely', async () => {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE_IDENTITY);
  const grant = await issueTrackUploadGrant(t);
  const storageIdWithoutMime = await t.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])]))
  );

  const result = await alice.mutation(api.routers.tts.persistTrack, {
    url: EXACT_CACHE_KEY,
    text: 'Exact timing',
    voice: 'Adrian',
    storageId: storageIdWithoutMime,
    grant: grant.grant,
    duration: 0.7,
    words: exactWords,
  });
  expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/audio\/mpeg/i) });

  const tracks = await t.run(async (ctx) => ctx.db.query('audioTracks').collect());
  expect(tracks).toEqual([]);
  expect(await t.run(async (ctx) => ctx.db.system.get('_storage', storageIdWithoutMime))).not.toBeNull();
});

test('upload grants are bound to their exact cache key, content digest, and voice', async () => {
  const variants = [
    { url: `${EXACT_CACHE_KEY}-changed`, text: 'Exact timing', voice: 'Adrian', words: exactWords },
    {
      url: EXACT_CACHE_KEY,
      text: 'Exact tracing',
      voice: 'Adrian',
      words: [exactWords[0]!, { ...exactWords[1]!, text: 'tracing' }],
    },
    { url: EXACT_CACHE_KEY, text: 'Exact timing', voice: 'Emma', words: exactWords },
  ];

  for (const variant of variants) {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity(ALICE_IDENTITY);
    const issued = (await alice.mutation(
      api.routers.tts.generateTrackUploadUrl,
      exactGrantBindings as any
    )) as { grant: string };
    const storageId = await storeBoundTrackUpload(t, issued.grant, new Uint8Array([1, 2, 3]));

    const result = await alice.mutation(api.routers.tts.persistTrack, {
      ...variant,
      grant: issued.grant,
      storageId,
      duration: 0.7,
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/grant|digest|voice|binding/i),
    });
    expect(await exactPersistenceWrites(t)).toEqual({ articles: [], tracks: [] });
  }
});

test('invalid-MIME and oversized bound uploads are deleted without rolling deletion back', async () => {
  for (const variant of ['mime', 'size'] as const) {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity(ALICE_IDENTITY);
    const issued = (await alice.mutation(
      api.routers.tts.generateTrackUploadUrl,
      exactGrantBindings as any
    )) as { grant: string };
    const storageId = await storeBoundTrackUpload(
      t,
      issued.grant,
      variant === 'size'
        ? new Uint8Array(25 * 1024 * 1024 + 1)
        : new Uint8Array([1, 2, 3]),
      variant === 'mime' ? 'application/octet-stream' : 'audio/mpeg'
    );

    const result = await alice.mutation(api.routers.tts.persistTrack, {
      url: EXACT_CACHE_KEY,
      text: 'Exact timing',
      voice: 'Adrian',
      grant: issued.grant,
      storageId,
      duration: 0.7,
      words: exactWords,
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(variant === 'mime' ? /audio\/mpeg|MIME/i : /large|size|byte/i),
    });

    const stored = await t.run(async (ctx) => ctx.db.system.get('_storage', storageId));
    expect(stored).toBeNull();
  }
});

test('bounded cleanup deletes only old unclaimed feature-marked uploads', async () => {
  const t = convexTest(schema, modules);
  const abandonedGrant = 'a'.repeat(64);
  const claimedGrant = 'b'.repeat(64);
  const oldUnclaimed = await storeBoundTrackUpload(
    t,
    abandonedGrant,
    new Uint8Array([1])
  );
  const claimed = await storeBoundTrackUpload(t, claimedGrant, new Uint8Array([2]));
  const unrelated = await t.run(async (ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([3])], { type: 'audio/mpeg' }))
  );
  const malformedMarker = await storeBoundTrackUpload(
    t,
    'not-a-feature-capability',
    new Uint8Array([4])
  );
  await t.run(async (ctx) => {
    await (ctx.db as any).patch(unrelated, { contentType: 'audio/mpeg' });
    const articleId = await ctx.db.insert('articles', {
      url: 'owner-scoped-cleanup-fixture',
      title: 'Cleanup fixture',
      content: 'Exact timing',
      author: 'Unknown',
      sourceType: 'text',
      wordCount: 2,
      createdAt: 1,
    });
    const trackId = await ctx.db.insert('audioTracks', {
      articleId,
      voice: 'Adrian',
      speed: 1,
      storageId: claimed,
      duration: 0.7,
      timingsSource: 'soniox',
      words: exactWords,
      createdAt: 1,
    });
    await (ctx.db as any).insert('ttsTrackStorageClaims', {
      storageId: claimed,
      trackId,
      kind: 'exact',
      ownerKey: ALICE_IDENTITY.tokenIdentifier,
      grantToken: claimedGrant,
      claimedAt: 1,
    });
  });

  const result = await t.mutation(
    (internal.routers.ttsInternal as any).cleanupAbandonedTrackUploads,
    { cursor: null, now: Date.now() + 2 * 60 * 60 * 1000 }
  );

  expect(result.scanned).toBeLessThanOrEqual(32);
  expect(result.deleted).toBe(1);
  const storage = await t.run(async (ctx) => ({
    oldUnclaimed: await ctx.db.system.get('_storage', oldUnclaimed),
    claimed: await ctx.db.system.get('_storage', claimed),
    unrelated: await ctx.db.system.get('_storage', unrelated),
    malformedMarker: await ctx.db.system.get('_storage', malformedMarker),
  }));
  expect(storage.oldUnclaimed).toBeNull();
  expect(storage.claimed).not.toBeNull();
  expect(storage.unrelated).not.toBeNull();
  expect(storage.malformedMarker).not.toBeNull();
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

function temporaryExpiry(offsetMs = 5 * 60 * 1000) {
  return new Date(Date.now() + offsetMs).toISOString();
}

test('temporaryKey posts the constrained Soniox request and returns only the temporary key', async () => {
  const t = convexTest(schema, modules);
  let request: RequestInit | undefined;

  await withSonioxServerKey(async () => {
    stubFetch((url, init) => {
      expect(url).toBe('https://api.soniox.com/v1/auth/temporary-api-key');
      request = init;
      return new Response(
        JSON.stringify({ api_key: 'temporary-soniox-key', expires_at: temporaryExpiry() }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await t.action(api.routers.tts.temporaryKey, { clientId: 'browser-client-123' });

    expect(result.apiKey).toBe('temporary-soniox-key');
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
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
    single_use: false,
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
      return new Response(JSON.stringify({ api_key: 'temporary-key', expires_at: temporaryExpiry() }), {
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
      new Response(JSON.stringify({ api_key: 'temporary-key', expires_at: temporaryExpiry() }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    for (let request = 0; request < 5; request += 1) {
      await expect(t.action(api.routers.tts.temporaryKey, { clientId: 'key-burst-client' })).resolves.toEqual({
        apiKey: 'temporary-key',
        expiresAt: expect.any(String),
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
      new Response(JSON.stringify({ expires_at: temporaryExpiry() }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await expect(t.action(api.routers.tts.temporaryKey, { clientId: 'malformed-response-client' })).rejects.toThrow(
      'Soniox returned an invalid temporary key response'
    );
  });
});

test('temporaryKey trims and bounds anonymous client IDs before attribution and limiting', async () => {
  const t = convexTest(schema, modules);
  let clientReferenceId: string | undefined;

  await withSonioxServerKey(async () => {
    stubFetch((_url, init) => {
      clientReferenceId = JSON.parse(String(init?.body)).client_reference_id;
      return new Response(
        JSON.stringify({ api_key: 'temporary-key', expires_at: temporaryExpiry() }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    });

    await t.action(api.routers.tts.temporaryKey, { clientId: '  browser-client  ' });
    await expect(
      t.action(api.routers.tts.temporaryKey, { clientId: 'x'.repeat(201) })
    ).rejects.toThrow(/200|too (?:big|long)|validation/i);
  });

  expect(clientReferenceId).toBe('browser-client');
  expect(fetchCalls).toHaveLength(1);
});

test('temporaryKey rejects upstream expiry outside the future ten-minute window', async () => {
  for (const offsetMs of [-1, 11 * 60 * 1000]) {
    const t = convexTest(schema, modules);
    await withSonioxServerKey(async () => {
      stubFetch(() =>
        new Response(
          JSON.stringify({ api_key: 'temporary-key', expires_at: temporaryExpiry(offsetMs) }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      );
      await expect(
        t.action(api.routers.tts.temporaryKey, { clientId: `expiry-${offsetMs}` })
      ).rejects.toThrow(/invalid temporary key response/i);
    });
    fetchCalls = [];
  }
});

// --- Global (server-generated) exact cache + pre-generation -----------------

async function finalizeGlobalTestTrack(t: ReturnType<typeof convexTest>, bytes: number[]) {
  const storageId = await storeUploadedTestAudio(t, bytes);
  return await t.mutation(internal.routers.ttsInternal.finalizeGlobalExactTrack, {
    contentDigest: EXACT_CONTENT_DIGEST,
    title: 'Exact timing',
    content: 'Exact timing',
    voice: 'Adrian',
    storageId,
    duration: 0.7,
    words: exactWords,
  });
}

test('a server-generated track is readable anonymously and by every signed-in listener', async () => {
  const t = convexTest(schema, modules);
  await finalizeGlobalTestTrack(t, [1, 2, 3]);

  // Content-only key (pasted text) and source-scoped key (URL article) both
  // end in the content digest, so both resolve to the same global track.
  for (const url of [
    EXACT_CACHE_KEY,
    `source-sha256:${'a'.repeat(64)}:${EXACT_CACHE_KEY}`,
  ]) {
    expect(await t.query(api.routers.tts.getExactTrack, { url, voice: 'Adrian' })).toMatchObject({
      words: exactWords,
      duration: 0.7,
      timingsSource: 'soniox',
    });
  }
  expect(
    await t.withIdentity(BOB_IDENTITY).query(api.routers.tts.getExactTrack, { url: EXACT_CACHE_KEY, voice: 'Adrian' })
  ).toMatchObject({ words: exactWords });
  // A different voice is a different track.
  expect(await t.query(api.routers.tts.getExactTrack, { url: EXACT_CACHE_KEY, voice: 'Emma' })).toBeNull();

  const claims = await t.run(async (ctx) => ctx.db.query('ttsTrackStorageClaims').collect());
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatchObject({ kind: 'exact', ownerKey: GLOBAL_TRACK_OWNER_KEY });
});

test('a client upload never lands in the global cache', async () => {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity(ALICE_IDENTITY);
  const grant = (await alice.mutation(api.routers.tts.generateTrackUploadUrl, exactGrantBindings as any)) as {
    grant: string;
  };
  const storageId = await storeBoundTrackUpload(t, grant.grant, new Uint8Array([1, 2, 3]));
  expect(
    await alice.mutation(api.routers.tts.persistTrack, {
      url: EXACT_CACHE_KEY,
      text: 'Exact timing',
      voice: 'Adrian',
      grant: grant.grant,
      storageId,
      duration: 0.7,
      words: exactWords,
    })
  ).toMatchObject({ ok: true });

  expect(await t.query(api.routers.tts.getExactTrack, { url: EXACT_CACHE_KEY, voice: 'Adrian' })).toBeNull();
  expect(
    await t.query(internal.routers.ttsInternal.findGlobalExactTrack, {
      contentDigest: EXACT_CONTENT_DIGEST,
      voice: 'Adrian',
    })
  ).toBeNull();
});

test('finalizeGlobalExactTrack rejects a digest that does not match the content', async () => {
  const t = convexTest(schema, modules);
  const storageId = await storeUploadedTestAudio(t, [1, 2, 3]);
  await expect(
    t.mutation(internal.routers.ttsInternal.finalizeGlobalExactTrack, {
      contentDigest: 'f'.repeat(64),
      content: 'Exact timing',
      voice: 'Adrian',
      storageId,
      duration: 0.7,
      words: exactWords,
    })
  ).rejects.toThrow(/digest/i);
});

async function waitForJobStatus(
  t: ReturnType<typeof convexTest>,
  status: 'running' | 'done' | 'failed'
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const jobs = await t.run(async (ctx) => ctx.db.query('ttsPregenerationJobs').collect());
    if (jobs.length === 1 && jobs[0]!.status === status) return jobs[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`pre-generation job never reached ${status}`);
}

test('pregenerate takes the job slot, runs the scheduled Node action, and reports ready once cached', async () => {
  const t = convexTest(schema, modules);
  stubFetch(() => {
    throw new Error('pregenerate must not call any provider from the default runtime');
  });
  const previousKey = process.env.SONIOX_API_KEY;
  delete process.env.SONIOX_API_KEY;

  try {
    const first = await t.action(api.routers.tts.pregenerate, { text: 'Exact timing', voice: 'Adrian', clientId: 'c1' });
    expect(first).toEqual({ status: 'scheduled' });

    // The scheduled action ran and, with no provider key, recorded why it
    // could not synthesise instead of throwing.
    const job = await waitForJobStatus(t, 'failed');
    expect(job).toMatchObject({ contentDigest: EXACT_CONTENT_DIGEST, voice: 'Adrian' });
    expect(job.error).toMatch(/SONIOX_API_KEY/);
    expect(fetchCalls).toEqual([]);

    // The slot itself: a failed job is reclaimable once, then held as running.
    expect(
      await t.mutation(internal.routers.ttsInternal.claimPregenerationJob, {
        contentDigest: EXACT_CONTENT_DIGEST,
        voice: 'Adrian',
      })
    ).toBe('claimed');
    expect(
      await t.mutation(internal.routers.ttsInternal.claimPregenerationJob, {
        contentDigest: EXACT_CONTENT_DIGEST,
        voice: 'Adrian',
      })
    ).toBe('running');

    await finalizeGlobalTestTrack(t, [1, 2, 3]);
    const third = await t.action(api.routers.tts.pregenerate, { text: 'Exact timing', voice: 'Adrian', clientId: 'c3' });
    expect(third).toEqual({ status: 'ready' });
  } finally {
    if (previousKey !== undefined) process.env.SONIOX_API_KEY = previousKey;
  }
});

test('pregenerate honours the global rate limit and never schedules when denied', async () => {
  const t = convexTest(schema, modules);
  await drainGlobalRateLimit(t);
  const result = await t.action(api.routers.tts.pregenerate, { text: 'Exact timing', voice: 'Adrian', clientId: 'c' });
  expect(result).toEqual({ status: 'skipped' });
  expect(await t.run(async (ctx) => ctx.db.query('ttsPregenerationJobs').collect())).toEqual([]);
});

test('pregenerationStatus reports none, then the job state, without needing sign-in', async () => {
  const t = convexTest(schema, modules);
  const input = { contentDigest: EXACT_CONTENT_DIGEST, voice: 'Adrian' };
  expect(await t.query(api.routers.tts.pregenerationStatus, input)).toBe('none');

  await t.mutation(internal.routers.ttsInternal.claimPregenerationJob, input);
  expect(await t.query(api.routers.tts.pregenerationStatus, input)).toBe('running');

  await t.mutation(internal.routers.ttsInternal.completePregenerationJob, { ...input, status: 'failed', error: 'x' });
  expect(await t.query(api.routers.tts.pregenerationStatus, input)).toBe('failed');

  await t.mutation(internal.routers.ttsInternal.completePregenerationJob, { ...input, status: 'done' });
  expect(await t.query(api.routers.tts.pregenerationStatus, input)).toBe('done');
});
