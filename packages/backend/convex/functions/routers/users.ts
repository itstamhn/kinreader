import { z } from 'zod';
import { v } from 'convex/values';
import { getSession } from 'kitcn/auth';
import { query, mutation } from '../crpc';
import { internalMutation, internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { renderWelcomeEmail, sendEmail } from '../../lib/email';
import { getEnv } from '../../lib/get-env';

/**
 * Resolves the authenticated user's record from Better Auth / Convex auth.
 * Returns null if the request is unauthenticated or user is not found.
 */
async function resolveAuthUser(ctx: any) {
  const authSession = (await getSession(ctx)) as { session?: any; user?: any } | null;
  if (authSession && 'user' in authSession && authSession.user) {
    return authSession.user;
  }
  const identity = await ctx.auth?.getUserIdentity?.();
  if (identity?.email) {
    const email = typeof identity.email === 'string' ? identity.email.toLowerCase() : '';
    return await ctx.db
      .query('user')
      .withIndex('email', (q: any) => q.eq('email', email))
      .first();
  }
  return null;
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

    let targetArticleId: any = input.articleId;
    const directDoc = await ctx.db.get(targetArticleId).catch(() => null);
    if (!directDoc) {
      const articleByUrl = await ctx.db
        .query('articles')
        .withIndex('by_url', (q: any) => q.eq('url', input.articleId))
        .first();
      if (articleByUrl) {
        targetArticleId = articleByUrl._id;
      }
    }

    const existing = await ctx.db
      .query('userArticles')
      .withIndex('by_user_article', (q: any) =>
        q.eq('userId', user._id).eq('articleId', targetArticleId)
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

    // Only insert if targetArticleId points to a real articles record
    const targetDoc = await ctx.db.get(targetArticleId).catch(() => null);
    if (targetDoc) {
      return await ctx.db.insert('userArticles', {
        userId: user._id,
        articleId: targetArticleId as any,
        progress: input.progress,
        lastWordIndex: input.lastWordIndex,
        currentTime: input.currentTime,
        isCompleted: input.isCompleted,
        updatedAt: now,
      });
    }

    return null;
  });

// 4. Delete Article from User Playlist (Derives identity server-side)
export const deleteUserArticle = mutation
  .input(z.object({ articleId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    const user = await resolveAuthUser(ctx);
    if (!user) {
      throw new Error('Unauthorized: You must be signed in to modify playlist');
    }

    let targetArticleId: any = input.articleId;
    const directDoc = await ctx.db.get(targetArticleId).catch(() => null);
    if (!directDoc) {
      const articleByUrl = await ctx.db
        .query('articles')
        .withIndex('by_url', (q: any) => q.eq('url', input.articleId))
        .first();
      if (articleByUrl) {
        targetArticleId = articleByUrl._id;
      }
    }

    const existing = await ctx.db
      .query('userArticles')
      .withIndex('by_user_article', (q: any) =>
        q.eq('userId', user._id).eq('articleId', targetArticleId)
      )
      .first();

    if (existing) {
      await ctx.db.delete(existing._id as any);
      return true;
    }
    return false;
  });

// 5. Add / Upsert Article to User Playlist (plan 020)
export const addToPlaylist = mutation
  .input(
    z.object({
      url: z.string().min(1),
      title: z.string(),
      content: z.string(),
      author: z.string().optional(),
      authorHandle: z.string().optional(),
      authorAvatar: z.string().optional(),
      image: z.string().optional(),
      sourceType: z.enum(['article', 'x', 'text']).optional(),
    })
  )
  .mutation(async ({ ctx, input }) => {
    const user = await resolveAuthUser(ctx);
    if (!user) {
      throw new Error('Unauthorized: You must be signed in to add articles to your playlist');
    }

    // 1. Find or insert into `articles` table
    let article = await ctx.db
      .query('articles')
      .withIndex('by_url', (q: any) => q.eq('url', input.url))
      .first();

    if (!article) {
      const wordCount = input.content.split(/\s+/).filter(Boolean).length;
      const articleData: Record<string, any> = {
        url: input.url,
        title: input.title.trim() || 'Untitled',
        content: input.content.slice(0, 900_000),
        author: input.author?.trim() || 'Unknown',
        sourceType: input.sourceType || 'article',
        wordCount,
        createdAt: Date.now(),
      };
      if (input.authorHandle) articleData.authorHandle = input.authorHandle;
      if (input.authorAvatar) articleData.authorAvatar = input.authorAvatar;
      if (input.image) articleData.image = input.image;

      const articleId = await ctx.db.insert('articles', articleData as any);
      article = await ctx.db.get(articleId);
    }

    if (!article) {
      throw new Error('Failed to create or retrieve article record');
    }

    // 2. Link into userArticles if not already present
    const existing = await ctx.db
      .query('userArticles')
      .withIndex('by_user_article', (q: any) =>
        q.eq('userId', user._id).eq('articleId', article._id as any)
      )
      .first();

    const now = Date.now();
    let userArticleId: any;
    if (!existing) {
      userArticleId = await ctx.db.insert('userArticles', {
        userId: user._id,
        articleId: article._id as any,
        progress: 0,
        lastWordIndex: 0,
        currentTime: 0,
        isCompleted: false,
        updatedAt: now,
      });
    } else {
      userArticleId = existing._id;
      await ctx.db.patch(existing._id as any, { updatedAt: now });
    }

    return {
      articleId: article._id,
      userArticleId,
      article,
    };
  });

// 7. Internal: Mark Email Bounced (from Webhook)
export const markEmailBounced = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const emailNorm = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query('user')
      .withIndex('email', (q: any) => q.eq('email', emailNorm))
      .first();

    if (user) {
      await ctx.db.patch(user._id, { emailBounced: true });
      console.log(`[LIST HYGIENE] Marked user ${user.email} as bounced.`);
      return { success: true };
    }
    return { success: false };
  },
});

// 8. Internal: Mark Email Complained (from Webhook)
export const markEmailComplained = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const emailNorm = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query('user')
      .withIndex('email', (q: any) => q.eq('email', emailNorm))
      .first();

    if (user) {
      await ctx.db.patch(user._id, { emailComplained: true });
      console.log(`[LIST HYGIENE] Marked user ${user.email} as complained.`);
      return { success: true };
    }
    return { success: false };
  },
});

// 9. Internal: Record Welcome Email Sent
export const recordWelcomeEmailSent = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const emailNorm = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query('user')
      .withIndex('email', (q: any) => q.eq('email', emailNorm))
      .first();

    if (user) {
      await ctx.db.patch(user._id, { welcomeEmailSentAt: Date.now() });
      return { success: true };
    }
    return { success: false };
  },
});

// 10. Internal: Send Welcome Email If Not Sent
export const sendWelcomeEmailIfNew = internalAction({
  args: { email: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const emailNorm = args.email.trim().toLowerCase();
    const siteUrl = getEnv().SITE_URL || 'https://app.kinreader.com';

    try {
      const { subject, html, text } = renderWelcomeEmail({
        email: emailNorm,
        name: args.name,
        appUrl: siteUrl,
      });

      await sendEmail({
        to: emailNorm,
        subject,
        html,
        text,
      });

      await ctx.runMutation(internal.routers.users.recordWelcomeEmailSent, { email: emailNorm });
      console.log(`[WELCOME EMAIL] Sent welcome email to ${emailNorm}`);
      return { sent: true };
    } catch (err) {
      console.error(`Failed to send welcome email to ${emailNorm}:`, err);
      return { sent: false };
    }
  },
});

