import { z } from 'zod';
import { action } from '../crpc';
import { internal } from '../_generated/api';
import { assertPublicHttpUrl } from '../../lib/articleUrl';
import { extractArticle } from '../../lib/extractArticle';

// Compatibility endpoint. Creation uses the same extractor from a scheduled worker.
export const extract = action.input(z.object({ url: z.string().min(1), clientId: z.string().trim().min(1).max(200).optional() }))
  .action(async ({ ctx, input }) => {
    const url = assertPublicHttpUrl(input.url.trim()).toString();
    const rate = await ctx.runMutation(internal.routers.articlesInternal.consumeExtractRateLimit, { key: input.clientId || 'anonymous' });
    if (!rate.ok) throw new Error('Too many article requests. Please try again in a minute.');
    return extractArticle(url);
  });
