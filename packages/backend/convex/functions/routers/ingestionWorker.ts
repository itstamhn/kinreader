import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { extractArticle } from '../../lib/extractArticle';
export const process = internalAction({
  args: { recordingId: v.id('listeningRecords'), attempt: v.number() }, returns: v.null(),
  handler: async (ctx, args) => {
    let record = await ctx.runQuery(internal.routers.ingestionInternal.work, args);
    if (!record) return null;
    try {
      if (record.stage === 'finding' && record.sourceUrl) {
        const { sourceUrl: _, ...article } = await extractArticle(record.sourceUrl);
        if (!await ctx.runMutation(internal.routers.ingestionInternal.capture, { ...args, ...article })) return null;
        record = await ctx.runQuery(internal.routers.ingestionInternal.work, args);
      }
      if (record?.stage !== 'preparing' || !record.narrationText) return null;
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.narrationText));
      const digest = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
      await ctx.runMutation(internal.routers.ingestionInternal.prepare, { ...args, digest });
    } catch {
      await ctx.runMutation(internal.routers.ingestionInternal.fail, { ...args, error: record?.stage === 'preparing' ? 'Audio preparation could not start. Your text is saved. Try again.' : 'We could not retrieve a readable article. The page may require a login. Try again or paste the text.' });
    }
    return null;
  },
});
