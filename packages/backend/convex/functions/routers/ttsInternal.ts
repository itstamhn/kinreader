import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import schema from '../schema';
import {
  TTS_GLOBAL_KEY,
  ttsClientRateLimiter,
  ttsGlobalRateLimiter,
  ttsTemporaryKeyClientRateLimiter,
} from '../../lib/rateLimiter';

// Plain (non-cRPC) internal functions backing convex/routers/tts.ts's
// action. Actions cannot touch `ctx.db` directly -- these are the
// `ctx.runQuery` / `ctx.runMutation` targets it uses instead.

// kitcn/ratelimit's `Ratelimit.limit()` writes state (schema.ts's
// `ratelimitState` table), so -- like every other write here -- it has to
// run inside a mutation, not the calling action.
//
// Consumes TWO limiters (see convex/lib/rateLimiter.ts for why both exist):
// the global one first, since it is the real security boundary and denying
// there should not also burn a token from the (bypassable) per-client
// bucket. `synthesize` reaches this only after a cache miss; `temporaryKey`
// reaches it before its direct Soniox key-issuance request.
async function consumeTtsRateLimits(
  ctx: MutationCtx,
  key: string,
  purpose: 'synthesize' | 'temporaryKey' | 'trackUpload' | undefined
): Promise<boolean> {
  const global = await ttsGlobalRateLimiter(ctx).limit(TTS_GLOBAL_KEY);
  if (!global.success) return false;

  const clientLimiter =
    purpose === 'temporaryKey' || purpose === 'trackUpload'
      ? ttsTemporaryKeyClientRateLimiter(ctx)
      : ttsClientRateLimiter(ctx);
  const client = await clientLimiter.limit(key);
  return client.success;
}

export const consumeTtsRateLimit = internalMutation({
  args: {
    key: v.string(),
    purpose: v.optional(
      v.union(v.literal('synthesize'), v.literal('temporaryKey'), v.literal('trackUpload'))
    ),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    return { ok: await consumeTtsRateLimits(ctx, args.key, args.purpose) };
  },
});

const TRACK_UPLOAD_GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_EXPIRED_GRANTS_CLEANED_PER_ISSUANCE = 32;
const MAX_EXACT_TRACK_BYTES = 25 * 1024 * 1024;
const ABANDONED_UPLOAD_AGE_MS = 65 * 60 * 1000;
const STORAGE_CLEANUP_PAGE_SIZE = 32;
const CONTENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TRACK_UPLOAD_GRANT_PATTERN = /^[0-9a-f]{64}$/;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function ownerScopedCacheKey(ownerKey: string, cacheKey: string): Promise<string> {
  return `tts-owner-sha256:${await sha256Hex(ownerKey)}:${cacheKey}`;
}

function trackUploadGrantFromContentType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  for (const parameter of contentType.split(';').slice(1)) {
    const [rawName, ...rawValue] = parameter.trim().split('=');
    if (rawName?.toLowerCase() === 'kinreader-grant') {
      const value = rawValue.join('=').trim();
      return value || null;
    }
  }
  return null;
}

function isMpegContentType(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'audio/mpeg';
}

export const issueTrackUploadGrant = internalMutation({
  args: {
    ownerKey: v.string(),
    cacheKey: v.string(),
    contentDigest: v.string(),
    voice: v.string(),
    token: v.string(),
    expiresAt: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(false) }),
    v.object({ ok: v.literal(true), grant: v.string(), expiresAt: v.number() })
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    if (
      !TRACK_UPLOAD_GRANT_PATTERN.test(args.token) ||
      !args.ownerKey ||
      !args.cacheKey ||
      args.cacheKey.length > 5000 ||
      !CONTENT_DIGEST_PATTERN.test(args.contentDigest) ||
      !args.voice ||
      args.voice.length > 100 ||
      args.expiresAt <= now ||
      args.expiresAt > now + TRACK_UPLOAD_GRANT_TTL_MS
    ) {
      throw new Error('Invalid track upload grant issuance');
    }

    const duplicate = await ctx.db
      .query('ttsExactUploadGrants')
      .withIndex('by_token', (q) => q.eq('token', args.token))
      .unique();
    if (duplicate) throw new Error('Duplicate track upload grant');

    if (!(await consumeTtsRateLimits(ctx, args.ownerKey, 'trackUpload'))) return { ok: false as const };

    const expiredGrants = await ctx.db
      .query('ttsExactUploadGrants')
      .withIndex('by_expires_at', (q) => q.lte('expiresAt', now))
      .take(MAX_EXPIRED_GRANTS_CLEANED_PER_ISSUANCE);
    for (const expiredGrant of expiredGrants) {
      await ctx.db.delete(expiredGrant._id);
    }

    await ctx.db.insert('ttsExactUploadGrants', {
      token: args.token,
      ownerKey: args.ownerKey,
      cacheKey: args.cacheKey,
      contentDigest: args.contentDigest,
      voice: args.voice,
      expiresAt: args.expiresAt,
      createdAt: now,
    });
    return { ok: true as const, grant: args.token, expiresAt: args.expiresAt };
  },
});

// Find-or-create the `articles` row a generated audio track hangs off of.
// Full article persistence (user libraries, ownership) is plan 008's job;
// this only exists so `audioTracks.articleId` -- the FK the existing
// `by_article_voice_speed` index is keyed on -- has something to point at.
// Keyed by URL (falling back to title for text pasted without a source
// URL), so repeat requests for the same article reuse the same row instead
// of growing the table forever.
export const getOrCreateArticleStub = internalMutation({
  args: {
    url: v.string(),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    content: v.string(),
    sourceType: v.optional(v.union(v.literal('article'), v.literal('x'), v.literal('text'))),
  },
  returns: v.id('articles'),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('articles')
      .withIndex('by_url', (q) => q.eq('url', args.url))
      .first();
    if (existing) return existing._id;

    const wordCount = args.content.split(/\s+/).filter(Boolean).length;
    return await ctx.db.insert('articles', {
      url: args.url,
      title: args.title?.trim() || 'Untitled',
      // Only a preview is kept here -- this row exists to give the audio
      // cache a stable key, not to persist the full article (plan 008).
      content: args.content.slice(0, 2000),
      author: args.author?.trim() || 'Unknown',
      sourceType: args.sourceType || 'article',
      wordCount,
      createdAt: Date.now(),
    });
  },
});

// Cache lookup keyed on URL, not `articleId` -- deliberately does NOT
// create the article row. `synthesize` is public and unauthenticated, so
// resolving the cache by URL (via the existing `articles.by_url` index)
// lets a cache hit stay entirely read-only: no article-stub write, no
// rate-limit token spent. Returns null (a clean miss) when no article with
// this URL exists yet, rather than creating one just to look something up
// in it.
export const findCachedTrackByUrl = internalQuery({
  args: {
    url: v.string(),
    voice: v.string(),
    speed: v.number(),
  },
  returns: v.union(v.null(), schema.doc('audioTracks')),
  handler: async (ctx, args) => {
    const article = await ctx.db
      .query('articles')
      .withIndex('by_url', (q) => q.eq('url', args.url))
      .first();
    if (!article) return null;

    return await ctx.db
      .query('audioTracks')
      .withIndex('by_article_voice_speed', (q) =>
        q.eq('articleId', article._id).eq('voice', args.voice).eq('speed', args.speed)
      )
      .first();
  },
});

function hasFullExactCoverage(track: Doc<'audioTracks'>, expectedWordCount: number): boolean {
  if (
    track.timingsSource !== 'soniox' ||
    track.speed !== 1 ||
    track.words.length === 0 ||
    track.words.length !== expectedWordCount ||
    track.words.length > 8192 ||
    !Number.isFinite(track.duration) ||
    track.duration <= 0
  ) {
    return false;
  }

  let previousEnd = 0;
  for (const word of track.words) {
    if (
      word.text.trim().length === 0 ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < previousEnd ||
      word.end <= word.start
    ) {
      return false;
    }
    previousEnd = word.end;
  }
  return Math.abs(previousEnd - track.duration) <= 0.01;
}

// The global (cross-user, anonymous-readable) exact cache. Only the server's
// own pre-generation path writes it -- a client upload can never carry this
// owner key, so nobody can poison the track everyone else hears.
export const GLOBAL_TRACK_OWNER_KEY = '__server__';

const wordTimingValidator = v.object({
  text: v.string(),
  start: v.number(),
  end: v.number(),
});
// Just past Convex's 10-minute action limit: a job still "running" after this
// was killed mid-flight and may be claimed again.
const PREGENERATION_STALE_MS = 11 * 60 * 1000;

export function globalCacheArticleUrl(contentDigest: string): string {
  return `tts-global:content-sha256:${contentDigest}`;
}

// Word timings that exactly cover `content`, in order, ending at `duration`.
// Shared by the owner-scoped and the global finalizers.
function assertExactWordCoverage(
  content: string,
  words: Array<{ text: string; start: number; end: number }>,
  duration: number
): string[] {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Invalid duration');
  const rawWords = content.split(/\s+/).filter(Boolean);
  if (rawWords.length === 0 || rawWords.length > 8192 || words.length !== rawWords.length) {
    throw new Error('Exact timings must cover every article word within the 8192-word limit');
  }
  let previousEnd = 0;
  for (const [index, word] of words.entries()) {
    if (
      word.text !== rawWords[index] ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < previousEnd ||
      word.end <= word.start
    ) {
      throw new Error(`Invalid exact word timing at index ${index}`);
    }
    previousEnd = word.end;
  }
  if (Math.abs(previousEnd - duration) > 0.01) {
    throw new Error('Exact duration must match the final word timing');
  }
  return rawWords;
}

async function exactTrackForArticleUrl(
  ctx: { db: MutationCtx['db'] },
  articleUrl: string,
  voice: string,
  expectedOwnerKey: string | null
): Promise<Doc<'audioTracks'> | null> {
  const article = await ctx.db
    .query('articles')
    .withIndex('by_url', (q) => q.eq('url', articleUrl))
    .unique();
  if (!article) return null;

  const track = await ctx.db
    .query('audioTracks')
    .withIndex('by_article_voice_speed', (q) =>
      q.eq('articleId', article._id).eq('voice', voice).eq('speed', 1)
    )
    .first();
  if (!track?.storageId || !hasFullExactCoverage(track, article.wordCount)) return null;

  const storedAudio = await ctx.db.system.get('_storage', track.storageId);
  if (
    !storedAudio ||
    storedAudio.size <= 0 ||
    storedAudio.size > MAX_EXACT_TRACK_BYTES ||
    !isMpegContentType(storedAudio.contentType)
  ) return null;

  const claim = await ctx.db
    .query('ttsTrackStorageClaims')
    .withIndex('by_storage_id', (q) => q.eq('storageId', track.storageId!))
    .unique();
  if (
    !claim ||
    claim.trackId !== track._id ||
    claim.kind !== 'exact' ||
    (expectedOwnerKey !== null && claim.ownerKey !== expectedOwnerKey)
  ) return null;
  return track;
}

// Readable by anyone, including anonymous listeners: the track was produced
// by the deployment itself, not uploaded by a user.
export const findGlobalExactTrack = internalQuery({
  args: { contentDigest: v.string(), voice: v.string() },
  returns: v.union(v.null(), schema.doc('audioTracks')),
  handler: async (ctx, args) => {
    if (!CONTENT_DIGEST_PATTERN.test(args.contentDigest)) return null;
    return await exactTrackForArticleUrl(
      ctx as unknown as { db: MutationCtx['db'] },
      globalCacheArticleUrl(args.contentDigest),
      args.voice,
      GLOBAL_TRACK_OWNER_KEY
    );
  },
});

// Take the (digest, voice) slot for one pre-generation run. Returns the state
// the caller should act on: `claimed` means run it; `running` means another
// run owns it; `done` means the track already exists.
export const claimPregenerationJob = internalMutation({
  args: { contentDigest: v.string(), voice: v.string() },
  returns: v.union(v.literal('claimed'), v.literal('running'), v.literal('done')),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query('ttsPregenerationJobs')
      .withIndex('by_digest_voice', (q) => q.eq('contentDigest', args.contentDigest).eq('voice', args.voice))
      .unique();
    if (existing) {
      if (existing.status === 'done') {
        // Trust the row only while the track it points at still exists.
        const track = await exactTrackForArticleUrl(
          ctx,
          globalCacheArticleUrl(args.contentDigest),
          args.voice,
          GLOBAL_TRACK_OWNER_KEY
        );
        if (track) return 'done';
      } else if (existing.status === 'running' && now - existing.startedAt < PREGENERATION_STALE_MS) {
        return 'running';
      }
      await ctx.db.patch(existing._id, { status: 'running', startedAt: now, finishedAt: undefined, error: undefined });
      return 'claimed';
    }
    await ctx.db.insert('ttsPregenerationJobs', {
      contentDigest: args.contentDigest,
      voice: args.voice,
      status: 'running',
      startedAt: now,
    });
    return 'claimed';
  },
});

// Raw job state for the reader's "wait for the running job" path. No wall
// clock here (queries must stay pure); the reader caps its own wait.
export const pregenerationJobStatus = internalQuery({
  args: { contentDigest: v.string(), voice: v.string() },
  returns: v.object({
    status: v.union(v.literal('none'), v.literal('running'), v.literal('done'), v.literal('failed')),
    startedAt: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query('ttsPregenerationJobs')
      .withIndex('by_digest_voice', (q) => q.eq('contentDigest', args.contentDigest).eq('voice', args.voice))
      .unique();
    if (!job) return { status: 'none' as const };
    return { status: job.status, startedAt: job.startedAt };
  },
});

export const completePregenerationJob = internalMutation({
  args: {
    contentDigest: v.string(),
    voice: v.string(),
    status: v.union(v.literal('done'), v.literal('failed')),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('ttsPregenerationJobs')
      .withIndex('by_digest_voice', (q) => q.eq('contentDigest', args.contentDigest).eq('voice', args.voice))
      .unique();
    const patch = {
      status: args.status,
      finishedAt: Date.now(),
      error: args.error?.slice(0, 500),
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else {
      await ctx.db.insert('ttsPregenerationJobs', {
        contentDigest: args.contentDigest,
        voice: args.voice,
        startedAt: Date.now(),
        ...patch,
      });
    }
    return null;
  },
});

// Records a server-generated track in the global cache. The blob must already
// be in storage; on any validation failure the caller deletes it.
export const finalizeGlobalExactTrack = internalMutation({
  args: {
    contentDigest: v.string(),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    content: v.string(),
    voice: v.string(),
    storageId: v.id('_storage'),
    duration: v.number(),
    words: v.array(wordTimingValidator),
  },
  returns: v.object({ articleId: v.id('articles'), trackId: v.id('audioTracks') }),
  handler: async (ctx, args) => {
    const content = args.content.trim();
    const voice = args.voice.trim();
    if (!CONTENT_DIGEST_PATTERN.test(args.contentDigest)) throw new Error('Invalid content digest');
    if ((await sha256Hex(content)) !== args.contentDigest) {
      throw new Error('Content digest does not match article content');
    }
    if (!content || content.length > 50000) throw new Error('Invalid article content');
    if (!voice || voice.length > 100) throw new Error('Invalid voice');
    const rawWords = assertExactWordCoverage(content, args.words, args.duration);

    const storedAudio = await ctx.db.system.get('_storage', args.storageId);
    if (!storedAudio || storedAudio.size <= 0 || !isMpegContentType(storedAudio.contentType)) {
      throw new Error('storageId must reference stored audio/mpeg data');
    }
    if (storedAudio.size > MAX_EXACT_TRACK_BYTES) {
      throw new Error(`Generated track exceeds the ${MAX_EXACT_TRACK_BYTES}-byte limit`);
    }
    const existingClaim = await ctx.db
      .query('ttsTrackStorageClaims')
      .withIndex('by_storage_id', (q) => q.eq('storageId', args.storageId))
      .unique();
    if (existingClaim) throw new Error('storageId was already finalized');

    const articleUrl = globalCacheArticleUrl(args.contentDigest);
    let article = await ctx.db
      .query('articles')
      .withIndex('by_url', (q) => q.eq('url', articleUrl))
      .unique();
    if (article) {
      await ctx.db.patch(article._id, {
        title: args.title?.trim() || article.title,
        author: args.author?.trim() || article.author,
        content: content.slice(0, 2000),
        wordCount: rawWords.length,
      });
    } else {
      const articleId = await ctx.db.insert('articles', {
        url: articleUrl,
        title: args.title?.trim() || 'Untitled',
        content: content.slice(0, 2000),
        author: args.author?.trim() || 'Unknown',
        sourceType: 'text',
        wordCount: rawWords.length,
        createdAt: Date.now(),
      });
      article = await ctx.db.get('articles', articleId);
    }
    if (!article) throw new Error('Failed to create the global cache entry');

    const existing = await ctx.db
      .query('audioTracks')
      .withIndex('by_article_voice_speed', (q) =>
        q.eq('articleId', article._id).eq('voice', voice).eq('speed', 1)
      )
      .first();
    const row = {
      articleId: article._id,
      voice,
      speed: 1,
      storageId: args.storageId,
      duration: args.duration,
      timingsSource: 'soniox' as const,
      words: args.words,
      createdAt: Date.now(),
    };
    let trackId: Id<'audioTracks'>;
    if (existing) {
      const oldClaim = await storageClaimForTrack(ctx, existing._id);
      await ctx.db.replace(existing._id, row);
      trackId = existing._id;
      await removeSupersededClaimedStorage(ctx, oldClaim, args.storageId);
    } else {
      trackId = await ctx.db.insert('audioTracks', row);
    }
    await claimTrackStorage(ctx, {
      storageId: args.storageId,
      trackId,
      kind: 'exact',
      ownerKey: GLOBAL_TRACK_OWNER_KEY,
    });
    return { articleId: article._id, trackId };
  },
});

// This is the strict cache path used before browser WebSocket synthesis. Old
// rows deliberately miss: exact playback requires explicit Soniox provenance,
// complete word coverage, speed 1.0, and a live audio/mpeg storage object.
export const findExactCachedTrackByUrl = internalQuery({
  args: {
    ownerKey: v.string(),
    cacheKey: v.string(),
    voice: v.string(),
  },
  returns: v.union(v.null(), schema.doc('audioTracks')),
  handler: async (ctx, args) => {
    const scopedCacheKey = await ownerScopedCacheKey(args.ownerKey, args.cacheKey);
    const article = await ctx.db
      .query('articles')
      .withIndex('by_url', (q) => q.eq('url', scopedCacheKey))
      .unique();
    if (!article) return null;

    const track = await ctx.db
      .query('audioTracks')
      .withIndex('by_article_voice_speed', (q) =>
        q.eq('articleId', article._id).eq('voice', args.voice).eq('speed', 1)
      )
      .first();
    if (!track?.storageId || !hasFullExactCoverage(track, article.wordCount)) return null;

    const storedAudio = await ctx.db.system.get('_storage', track.storageId);
    if (
      !storedAudio ||
      storedAudio.size <= 0 ||
      storedAudio.size > MAX_EXACT_TRACK_BYTES ||
      !isMpegContentType(storedAudio.contentType)
    ) return null;

    const claim = await ctx.db
      .query('ttsTrackStorageClaims')
      .withIndex('by_storage_id', (q) => q.eq('storageId', track.storageId!))
      .unique();
    if (
      !claim ||
      claim.trackId !== track._id ||
      claim.kind !== 'exact' ||
      claim.ownerKey !== args.ownerKey
    ) return null;
    return track;
  },
});


type TrackStorageClaimKind = 'exact' | 'rest';

async function storageClaimForTrack(ctx: MutationCtx, trackId: Id<'audioTracks'>) {
  return await ctx.db
    .query('ttsTrackStorageClaims')
    .withIndex('by_track_id', (q) => q.eq('trackId', trackId))
    .unique();
}

async function claimTrackStorage(
  ctx: MutationCtx,
  args: {
    storageId: Id<'_storage'>;
    trackId: Id<'audioTracks'>;
    kind: TrackStorageClaimKind;
    ownerKey?: string;
    grantToken?: string;
  }
) {
  const existingStorageClaim = await ctx.db
    .query('ttsTrackStorageClaims')
    .withIndex('by_storage_id', (q) => q.eq('storageId', args.storageId))
    .unique();
  if (existingStorageClaim && existingStorageClaim.trackId !== args.trackId) {
    throw new Error('storageId was already finalized');
  }

  const claim = {
    storageId: args.storageId,
    trackId: args.trackId,
    kind: args.kind,
    ...(args.ownerKey ? { ownerKey: args.ownerKey } : {}),
    ...(args.grantToken ? { grantToken: args.grantToken } : {}),
    claimedAt: Date.now(),
  };
  if (existingStorageClaim) {
    await ctx.db.replace(existingStorageClaim._id, claim);
  } else {
    await ctx.db.insert('ttsTrackStorageClaims', claim);
  }
}

async function removeSupersededClaimedStorage(
  ctx: MutationCtx,
  oldClaim: Doc<'ttsTrackStorageClaims'> | null,
  replacementStorageId: Id<'_storage'>
) {
  if (!oldClaim || oldClaim.storageId === replacementStorageId) return;
  await ctx.db.delete(oldClaim._id);
  const oldStorage = await ctx.db.system.get('_storage', oldClaim.storageId);
  if (oldStorage) await ctx.storage.delete(oldClaim.storageId);
}

export const insertAudioTrack = internalMutation({
  args: {
    articleId: v.id('articles'),
    voice: v.string(),
    speed: v.number(),
    storageId: v.id('_storage'),
    duration: v.number(),
    timingsSource: v.optional(v.union(v.literal('soniox'), v.literal('estimated'))),
    words: v.array(wordTimingValidator),
  },
  returns: v.id('audioTracks'),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('audioTracks')
      .withIndex('by_article_voice_speed', (q) =>
        q.eq('articleId', args.articleId).eq('voice', args.voice).eq('speed', args.speed)
      )
      .first();

    if (existing) {
      const oldClaim = await storageClaimForTrack(ctx, existing._id);
      await ctx.db.replace(existing._id, {
        articleId: args.articleId,
        voice: args.voice,
        speed: args.speed,
        storageId: args.storageId,
        duration: args.duration,
        timingsSource: args.timingsSource,
        words: args.words,
        createdAt: Date.now(),
      });
      await removeSupersededClaimedStorage(ctx, oldClaim, args.storageId);
      await claimTrackStorage(ctx, {
        storageId: args.storageId,
        trackId: existing._id,
        kind: 'rest',
      });
      return existing._id;
    }

    const trackId = await ctx.db.insert('audioTracks', {
      articleId: args.articleId,
      voice: args.voice,
      speed: args.speed,
      storageId: args.storageId,
      duration: args.duration,
      timingsSource: args.timingsSource,
      words: args.words,
      createdAt: Date.now(),
    });
    await claimTrackStorage(ctx, {
      storageId: args.storageId,
      trackId,
      kind: 'rest',
    });
    return trackId;
  },
});

export const finalizeExactTrack = internalMutation({
  args: {
    ownerKey: v.string(),
    cacheKey: v.string(),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    content: v.string(),
    voice: v.string(),
    grant: v.string(),
    storageId: v.id('_storage'),
    duration: v.number(),
    words: v.array(wordTimingValidator),
  },
  returns: v.object({
    articleId: v.id('articles'),
    trackId: v.id('audioTracks'),
  }),
  handler: async (ctx, args) => {
    const ownerKey = args.ownerKey;
    const cacheKey = args.cacheKey.trim();
    const content = args.content.trim();
    const voice = args.voice.trim();
    if (!ownerKey) throw new Error('Authenticated owner is required');
    if (!cacheKey || cacheKey.length > 5000) throw new Error('Invalid exact cache key');
    if (!content || content.length > 50000) throw new Error('Invalid article content');
    if (!voice || voice.length > 100) throw new Error('Invalid voice');
    const rawWords = assertExactWordCoverage(content, args.words, args.duration);

    const grant = await ctx.db
      .query('ttsExactUploadGrants')
      .withIndex('by_token', (q) => q.eq('token', args.grant))
      .unique();
    if (!grant) throw new Error('Invalid or already used track upload grant');
    if (grant.expiresAt <= Date.now()) throw new Error('Track upload grant has expired');
    if (
      grant.ownerKey !== ownerKey ||
      grant.cacheKey !== cacheKey ||
      grant.voice !== voice
    ) {
      throw new Error('Track upload grant binding does not match owner, cache key, or voice');
    }
    if ((await sha256Hex(content)) !== grant.contentDigest) {
      throw new Error('Track upload grant content digest does not match article content');
    }

    const storedAudio = await ctx.db.system.get('_storage', args.storageId);
    if (!storedAudio || storedAudio.size <= 0) {
      throw new Error('storageId must reference uploaded audio/mpeg data');
    }
    if (
      !isMpegContentType(storedAudio.contentType) ||
      trackUploadGrantFromContentType(storedAudio.contentType) !== args.grant
    ) {
      throw new Error('storageId must reference the grant-bound audio/mpeg upload');
    }
    if (storedAudio.size > MAX_EXACT_TRACK_BYTES) {
      throw new Error(`Exact track upload exceeds the ${MAX_EXACT_TRACK_BYTES}-byte limit`);
    }

    const storageClaim = await ctx.db
      .query('ttsTrackStorageClaims')
      .withIndex('by_storage_id', (q) => q.eq('storageId', args.storageId))
      .unique();
    if (storageClaim) throw new Error('storageId was already finalized');

    const scopedCacheKey = await ownerScopedCacheKey(ownerKey, cacheKey);
    let article = await ctx.db
      .query('articles')
      .withIndex('by_url', (q) => q.eq('url', scopedCacheKey))
      .unique();
    if (article) {
      await ctx.db.patch(article._id, {
        title: args.title?.trim() || article.title,
        author: args.author?.trim() || article.author,
        content: content.slice(0, 2000),
        wordCount: rawWords.length,
      });
    } else {
      const articleId = await ctx.db.insert('articles', {
        url: scopedCacheKey,
        title: args.title?.trim() || 'Untitled',
        content: content.slice(0, 2000),
        author: args.author?.trim() || 'Unknown',
        sourceType: 'text',
        wordCount: rawWords.length,
        createdAt: Date.now(),
      });
      article = await ctx.db.get('articles', articleId);
    }
    if (!article) throw new Error('Failed to create article cache entry');

    const existing = await ctx.db
      .query('audioTracks')
      .withIndex('by_article_voice_speed', (q) =>
        q.eq('articleId', article._id).eq('voice', voice).eq('speed', 1)
      )
      .first();

    let trackId: Id<'audioTracks'>;
    if (existing) {
      const oldClaim = await storageClaimForTrack(ctx, existing._id);
      await ctx.db.replace(existing._id, {
        articleId: article._id,
        voice,
        speed: 1,
        storageId: args.storageId,
        duration: args.duration,
        timingsSource: 'soniox',
        words: args.words,
        createdAt: Date.now(),
      });
      trackId = existing._id;
      await removeSupersededClaimedStorage(ctx, oldClaim, args.storageId);
    } else {
      trackId = await ctx.db.insert('audioTracks', {
        articleId: article._id,
        voice,
        speed: 1,
        storageId: args.storageId,
        duration: args.duration,
        timingsSource: 'soniox',
        words: args.words,
        createdAt: Date.now(),
      });
    }

    await claimTrackStorage(ctx, {
      storageId: args.storageId,
      trackId,
      kind: 'exact',
      ownerKey,
      grantToken: args.grant,
    });
    await ctx.db.delete(grant._id);

    return { articleId: article._id, trackId };
  },
});

// Runs only after a nested finalization transaction rolls back. A rejected
// blob is deleted only when the authenticated owner's still-live capability
// matches every requested binding and the blob carries that unguessable grant
// in its MIME parameter. This prevents a caller from deleting arbitrary
// storage IDs while allowing invalid MIME/oversize uploads to be reclaimed.
export const rejectExactTrackUpload = internalMutation({
  args: {
    ownerKey: v.string(),
    cacheKey: v.string(),
    content: v.string(),
    voice: v.string(),
    grant: v.string(),
    storageId: v.id('_storage'),
  },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, args) => {
    const grant = await ctx.db
      .query('ttsExactUploadGrants')
      .withIndex('by_token', (q) => q.eq('token', args.grant))
      .unique();
    if (
      !grant ||
      grant.ownerKey !== args.ownerKey ||
      grant.cacheKey !== args.cacheKey.trim() ||
      grant.voice !== args.voice.trim() ||
      grant.contentDigest !== (await sha256Hex(args.content.trim()))
    ) return { deleted: false };

    const claim = await ctx.db
      .query('ttsTrackStorageClaims')
      .withIndex('by_storage_id', (q) => q.eq('storageId', args.storageId))
      .unique();
    if (claim) return { deleted: false };

    const storedAudio = await ctx.db.system.get('_storage', args.storageId);
    if (
      !storedAudio ||
      trackUploadGrantFromContentType(storedAudio.contentType) !== args.grant
    ) return { deleted: false };

    await ctx.storage.delete(args.storageId);
    await ctx.db.delete(grant._id);
    return { deleted: true };
  },
});

type CleanupResult = {
  scanned: number;
  deleted: number;
  continueCursor: string | null;
};

// Direct upload URLs cannot attach arbitrary database metadata. The browser
// therefore marks only this feature's uploads with `kinreader-grant=<token>`
// in the MIME parameter. This bounded sweep deletes an old marked blob only
// when the new empty claim table proves it was never finalized; plain MP3s,
// claimed tracks, and every unrelated storage type are outside the invariant.
export const cleanupAbandonedTrackUploads = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    now: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    deleted: v.number(),
    continueCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args): Promise<CleanupResult> => {
    const now = args.now ?? Date.now();
    const cutoff = now - ABANDONED_UPLOAD_AGE_MS;
    const page = await ctx.db.system
      .query('_storage')
      .order('asc')
      .paginate({ numItems: STORAGE_CLEANUP_PAGE_SIZE, cursor: args.cursor });
    let deleted = 0;
    let reachedRecentStorage = false;

    for (const storedAudio of page.page) {
      if (storedAudio._creationTime > cutoff) {
        reachedRecentStorage = true;
        break;
      }
      const grantToken = trackUploadGrantFromContentType(storedAudio.contentType);
      if (!grantToken || !TRACK_UPLOAD_GRANT_PATTERN.test(grantToken)) continue;

      const claim = await ctx.db
        .query('ttsTrackStorageClaims')
        .withIndex('by_storage_id', (q) => q.eq('storageId', storedAudio._id))
        .unique();
      if (claim) continue;

      await ctx.storage.delete(storedAudio._id);
      const grant = await ctx.db
        .query('ttsExactUploadGrants')
        .withIndex('by_token', (q) => q.eq('token', grantToken))
        .unique();
      if (grant) await ctx.db.delete(grant._id);
      deleted += 1;
    }

    const continueCursor = !page.isDone && !reachedRecentStorage ? page.continueCursor : null;
    if (continueCursor) {
      await ctx.scheduler.runAfter(
        0,
        internal.routers.ttsInternal.cleanupAbandonedTrackUploads,
        { cursor: continueCursor, now }
      );
    }
    return { scanned: page.page.length, deleted, continueCursor };
  },
});
