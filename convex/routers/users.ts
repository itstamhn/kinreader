import { mutation, query } from '../_generated/server';
import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';

// 1. Upsert User on Sign In (Magic Link / Google)
export const upsertUser = mutation({
  args: {
    email: v.string(),
    name: v.string(),
    avatar: v.optional(v.string()),
    provider: v.union(v.literal('email'), v.literal('google'), v.literal('apple')),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    const existing = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', email))
      .first();

    const now = Date.now();
    let userId: Id<'users'>;

    if (existing) {
      userId = existing._id;
      await ctx.db.patch(userId, {
        name: args.name || existing.name,
        avatar: args.avatar || existing.avatar,
        lastLoginAt: now,
      });
    } else {
      userId = await ctx.db.insert('users', {
        email,
        name: args.name,
        avatar: args.avatar,
        tier: 'pro',
        provider: args.provider,
        createdAt: now,
        lastLoginAt: now,
      });
    }

    // Create a 30-day session token
    const token = crypto.randomUUID();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    await ctx.db.insert('sessions', {
      userId,
      token,
      expiresAt,
    });

    const user = await ctx.db.get(userId);
    return {
      user: {
        id: userId,
        email: user?.email,
        name: user?.name,
        avatar: user?.avatar,
        tier: user?.tier,
      },
      sessionToken: token,
    };
  },
});

// 2. Get User's Cloud Playlist & Progress
export const getUserPlaylist = query({
  args: {
    userId: v.id('users'),
  },
  handler: async (ctx, args) => {
    const userItems = await ctx.db
      .query('userArticles')
      .withIndex('by_user', (q) => q.eq('userId', args.userId))
      .order('desc')
      .collect();

    const results = [];
    for (const item of userItems) {
      const article = await ctx.db.get(item.articleId);
      if (article) {
        results.push({
          id: item._id,
          articleId: item.articleId,
          article,
          progress: item.progress,
          lastWordIndex: item.lastWordIndex,
          currentTime: item.currentTime,
          isCompleted: item.isCompleted,
          updatedAt: item.updatedAt,
        });
      }
    }
    return results;
  },
});

// 3. Save / Update User Reading Progress
export const saveUserProgress = mutation({
  args: {
    userId: v.id('users'),
    articleId: v.id('articles'),
    progress: v.number(),
    lastWordIndex: v.number(),
    currentTime: v.number(),
    isCompleted: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('userArticles')
      .withIndex('by_user_article', (q) => q.eq('userId', args.userId).eq('articleId', args.articleId))
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        progress: args.progress,
        lastWordIndex: args.lastWordIndex,
        currentTime: args.currentTime,
        isCompleted: args.isCompleted,
        updatedAt: now,
      });
      return existing._id;
    } else {
      return await ctx.db.insert('userArticles', {
        userId: args.userId,
        articleId: args.articleId,
        progress: args.progress,
        lastWordIndex: args.lastWordIndex,
        currentTime: args.currentTime,
        isCompleted: args.isCompleted,
        updatedAt: now,
      });
    }
  },
});
