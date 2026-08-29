import { internalAction, internalMutation, mutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import { renderWeeklyDigestEmail, sendEmail } from '../../lib/email';
import { getEnv } from '../../lib/get-env';

const AVERAGE_READING_WPM = 200;
const KINETIC_RSVP_WPM = 450;

/**
 * Calculates time saved in minutes from kinetic reading.
 */
export function calculateTimeSaved(wordsRead: number): number {
  if (wordsRead <= 0) return 0;
  const normalMinutes = wordsRead / AVERAGE_READING_WPM;
  const kineticMinutes = wordsRead / KINETIC_RSVP_WPM;
  return Math.max(1, Math.round(normalMinutes - kineticMinutes));
}

/**
 * Mutation to mark a user as opted out of digest emails.
 */
export const unsubscribeDigest = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const emailNorm = args.email.trim().toLowerCase();
    const user = await ctx.db
      .query('user')
      .withIndex('email', (q) => q.eq('email', emailNorm))
      .first();

    if (user) {
      await ctx.db.patch(user._id, { digestOptOut: true });
      return { success: true, message: 'Unsubscribed from weekly digest' };
    }
    return { success: false, message: 'User not found' };
  },
});

/**
 * Internal mutation to collect eligible users for digest.
 */
export const getWeeklyDigestRecipients = internalMutation({
  args: {},
  handler: async (ctx) => {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const users = await ctx.db.query('user').collect();

    const results: Array<{
      email: string;
      name?: string;
      stats: {
        wordsRead: number;
        articlesCompleted: number;
        timeSavedMinutes: number;
      };
      queueCount: number;
    }> = [];

    for (const user of users) {
      // Check list hygiene & consent
      if (user.emailBounced || user.emailComplained || user.digestOptOut) {
        continue;
      }

      const userArticles = await ctx.db
        .query('userArticles')
        .withIndex('by_user', (q) => q.eq('userId', user._id))
        .collect();

      let wordsRead = 0;
      let articlesCompleted = 0;
      let queueCount = 0;

      for (const ua of userArticles) {
        if (!ua.isCompleted) {
          queueCount++;
        }
        if (ua.updatedAt >= oneWeekAgo) {
          if (ua.isCompleted) {
            articlesCompleted++;
          }
          const article = await ctx.db.get(ua.articleId);
          if (article && article.wordCount) {
            // Fraction of words read based on progress
            const fraction = Math.min(1, Math.max(0, ua.progress / 100));
            wordsRead += Math.round(article.wordCount * fraction);
          }
        }
      }

      // Only send if there was some activity or active queue
      if (wordsRead > 0 || articlesCompleted > 0 || queueCount > 0) {
        results.push({
          email: user.email,
          name: user.name,
          stats: {
            wordsRead,
            articlesCompleted,
            timeSavedMinutes: calculateTimeSaved(wordsRead),
          },
          queueCount,
        });
      }
    }

    return results;
  },
});

/**
 * Action to run the weekly digest email dispatch.
 */
export const sendWeeklyDigests = internalAction({
  args: {},
  handler: async (ctx) => {
    const recipients = await ctx.runMutation(internal.routers.digest.getWeeklyDigestRecipients, {});
    const siteUrl = getEnv().SITE_URL || 'https://app.kinreader.com';

    let sentCount = 0;
    for (const recipient of recipients) {
      try {
        const unsubscribeUrl = `${siteUrl}/api/unsubscribe?email=${encodeURIComponent(recipient.email)}`;
        const { subject, html, text } = renderWeeklyDigestEmail({
          email: recipient.email,
          name: recipient.name,
          stats: recipient.stats,
          queueCount: recipient.queueCount,
          appUrl: siteUrl,
          unsubscribeUrl,
        });

        await sendEmail({
          to: recipient.email,
          subject,
          html,
          text,
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        sentCount++;
      } catch (err) {
        console.error(`Failed to send weekly digest to ${recipient.email}:`, err);
      }
    }

    console.log(`Weekly digest completed: ${sentCount} emails sent.`);
    return { sent: sentCount };
  },
});
