import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
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
export const consumeTtsRateLimit = internalMutation({
  args: {
    key: v.string(),
    purpose: v.optional(
      v.union(v.literal('synthesize'), v.literal('temporaryKey'), v.literal('trackUpload'))
    ),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const global = await ttsGlobalRateLimiter(ctx).limit(TTS_GLOBAL_KEY);
    if (!global.success) return { ok: false };

    const clientLimiter =
      args.purpose === 'temporaryKey' || args.purpose === 'trackUpload'
        ? ttsTemporaryKeyClientRateLimiter(ctx)
        : ttsClientRateLimiter(ctx);
    const client = await clientLimiter.limit(args.key);
    return { ok: client.success };
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

// This is the strict cache path used before browser WebSocket synthesis. Old
// rows deliberately miss: exact playback requires explicit Soniox provenance,
// complete word coverage, speed 1.0, and a live audio/mpeg storage object.
export const findExactCachedTrackByUrl = internalQuery({
  args: {
    url: v.string(),
    voice: v.string(),
  },
  returns: v.union(v.null(), schema.doc('audioTracks')),
  handler: async (ctx, args) => {
    const article = await ctx.db
      .query('articles')
      .withIndex('by_url', (q) => q.eq('url', args.url))
      .first();
    if (!article) return null;

    const track = await ctx.db
      .query('audioTracks')
      .withIndex('by_article_voice_speed', (q) =>
        q.eq('articleId', article._id).eq('voice', args.voice).eq('speed', 1)
      )
      .first();
    if (!track?.storageId || !hasFullExactCoverage(track, article.wordCount)) return null;

    const storedAudio = await ctx.db.system.get('_storage', track.storageId);
    if (!storedAudio || storedAudio.size <= 0 || storedAudio.contentType !== 'audio/mpeg') return null;
    return track;
  },
});

const wordTimingValidator = v.object({
  text: v.string(),
  start: v.number(),
  end: v.number(),
});

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
      if (existing.storageId && existing.storageId !== args.storageId) {
        const oldStorage = await ctx.db.system.get('_storage', existing.storageId);
        if (oldStorage) await ctx.storage.delete(existing.storageId);
      }
      return existing._id;
    }

    return await ctx.db.insert('audioTracks', {
      articleId: args.articleId,
      voice: args.voice,
      speed: args.speed,
      storageId: args.storageId,
      duration: args.duration,
      timingsSource: args.timingsSource,
      words: args.words,
      createdAt: Date.now(),
    });
  },
});

export const finalizeExactTrack = internalMutation({
  args: {
    url: v.string(),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    content: v.string(),
    voice: v.string(),
    storageId: v.id('_storage'),
    duration: v.number(),
    words: v.array(wordTimingValidator),
  },
  returns: v.object({
    articleId: v.id('articles'),
    trackId: v.id('audioTracks'),
  }),
  handler: async (ctx, args) => {
    const url = args.url.trim();
    const content = args.content.trim();
    const voice = args.voice.trim();
    if (!url || url.length > 4096) throw new Error('Invalid article URL');
    if (!content || content.length > 50000) throw new Error('Invalid article content');
    if (!voice || voice.length > 100) throw new Error('Invalid voice');
    if (!Number.isFinite(args.duration) || args.duration <= 0) throw new Error('Invalid duration');

    const rawWords = content.split(/\s+/).filter(Boolean);
    if (rawWords.length === 0 || rawWords.length > 8192 || args.words.length !== rawWords.length) {
      throw new Error('Exact timings must cover every article word within the 8192-word limit');
    }

    let previousEnd = 0;
    for (const [index, word] of args.words.entries()) {
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
    if (Math.abs(previousEnd - args.duration) > 0.01) {
      throw new Error('Exact duration must match the final word timing');
    }

    const storedAudio = await ctx.db.system.get('_storage', args.storageId);
    if (!storedAudio || storedAudio.size <= 0 || storedAudio.contentType !== 'audio/mpeg') {
      throw new Error('storageId must reference uploaded audio/mpeg data');
    }

    let article = await ctx.db
      .query('articles')
      .withIndex('by_url', (q) => q.eq('url', url))
      .first();
    if (article) {
      await ctx.db.patch(article._id, {
        title: args.title?.trim() || article.title,
        author: args.author?.trim() || article.author,
        content: content.slice(0, 2000),
        wordCount: rawWords.length,
      });
    } else {
      const articleId = await ctx.db.insert('articles', {
        url,
        title: args.title?.trim() || 'Untitled',
        content: content.slice(0, 2000),
        author: args.author?.trim() || 'Unknown',
        sourceType: 'article',
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

    let trackId;
    if (existing) {
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
      if (existing.storageId && existing.storageId !== args.storageId) {
        const oldStorage = await ctx.db.system.get('_storage', existing.storageId);
        if (oldStorage) await ctx.storage.delete(existing.storageId);
      }
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

    return { articleId: article._id, trackId };
  },
});
