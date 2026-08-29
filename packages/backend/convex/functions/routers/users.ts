import { z } from 'zod';
import { query, mutation } from '../crpc';

/**
 * Resolves the authenticated user's record from Better Auth / Convex auth.
 * Returns null if the request is unauthenticated or user is not found.
 */
async function resolveAuthUser(ctx: { auth: { getUserIdentity: () => Promise<any> }; db: any }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || !identity.email) {
    return null;
  }
  const email = typeof identity.email === 'string' ? identity.email.toLowerCase() : '';
  return await ctx.db
    .query('user')
    .withIndex('email', (q: any) => q.eq('email', email))
    .first();
}

// 1. Get Current Authenticated User Profile
export const getCurrentUser = query
  .input(z.object({}))
  .query(async ({ ctx }) => {
    const user = await resolveAuthUser(ctx);
    if (!user) return null;
    return {
      id: user._id,
      name: user.name,
      email: user.email,
      image: user.image,
      tier: user.tier ?? 'pro',
    };
  });

// 2. Get User's Cloud Playlist & Progress (Derives identity server-side)
export const getUserPlaylist = query
  .input(z.object({}))
  .query(async ({ ctx }) => {
    const user = await resolveAuthUser(ctx);
    if (!user) return [];

    const userItems = await ctx.db
      .query('userArticles')
      .withIndex('by_user', (q: any) => q.eq('userId', user._id))
      .order('desc')
      .collect();

    const results = [];
    for (const item of userItems) {
      const article = await ctx.db.get(item.articleId as any);
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
  });

// 3. Save / Update User Reading Progress (Derives identity server-side)
export const saveUserProgress = mutation
  .input(
    z.object({
      articleId: z.string(),
      progress: z.number(),
      lastWordIndex: z.number(),
      currentTime: z.number(),
      isCompleted: z.boolean(),
    })
  )
  .mutation(async ({ ctx, input }) => {
    const user = await resolveAuthUser(ctx);
    if (!user) {
      throw new Error('Unauthorized: You must be signed in to save reading progress');
    }

    const articleId = input.articleId;
    const existing = await ctx.db
      .query('userArticles')
      .withIndex('by_user_article', (q: any) =>
        q.eq('userId', user._id).eq('articleId', articleId)
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id as any, {
        progress: input.progress,
        lastWordIndex: input.lastWordIndex,
        currentTime: input.currentTime,
        isCompleted: input.isCompleted,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert('userArticles', {
      userId: user._id,
      articleId,
      progress: input.progress,
      lastWordIndex: input.lastWordIndex,
      currentTime: input.currentTime,
      isCompleted: input.isCompleted,
      updatedAt: now,
    });
  });

// 4. Delete Article from User Playlist (Derives identity server-side)
export const deleteUserArticle = mutation
  .input(z.object({ articleId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    const user = await resolveAuthUser(ctx);
    if (!user) {
      throw new Error('Unauthorized: You must be signed in to modify playlist');
    }

    const articleId = input.articleId;
    const existing = await ctx.db
      .query('userArticles')
      .withIndex('by_user_article', (q: any) =>
        q.eq('userId', user._id).eq('articleId', articleId)
      )
      .first();

    if (existing) {
      await ctx.db.delete(existing._id as any);
      return true;
    }
    return false;
  });
