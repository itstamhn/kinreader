import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
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
    purpose: v.optional(v.union(v.literal('synthesize'), v.literal('temporaryKey'))),
  },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const global = await ttsGlobalRateLimiter(ctx).limit(TTS_GLOBAL_KEY);
    if (!global.success) return { ok: false };

    const clientLimiter =
      args.purpose === 'temporaryKey' ? ttsTemporaryKeyClientRateLimiter(ctx) : ttsClientRateLimiter(ctx);
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

export const insertAudioTrack = internalMutation({
  args: {
    articleId: v.id('articles'),
    voice: v.string(),
    speed: v.number(),
    storageId: v.id('_storage'),
    duration: v.number(),
    words: v.array(
      v.object({
        text: v.string(),
        start: v.number(),
        end: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('audioTracks')
      .withIndex('by_article_voice_speed', (q) =>
        q.eq('articleId', args.articleId).eq('voice', args.voice).eq('speed', args.speed)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        storageId: args.storageId,
        duration: args.duration,
        words: args.words,
        createdAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert('audioTracks', {
      articleId: args.articleId,
      voice: args.voice,
      speed: args.speed,
      storageId: args.storageId,
      duration: args.duration,
      words: args.words,
      createdAt: Date.now(),
    });
  },
});
