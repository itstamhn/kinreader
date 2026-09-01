import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import {
  EXTRACT_GLOBAL_KEY,
  extractClientRateLimiter,
  extractGlobalRateLimiter,
} from '../../lib/rateLimiter';

// `articles.extract` is an action and cannot write limiter state itself; it
// consumes its budget through this mutation before the first fetch. Global
// first, so a denial there does not also charge the per-client bucket.
export const consumeExtractRateLimit = internalMutation({
  args: { key: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const global = await extractGlobalRateLimiter(ctx).limit(EXTRACT_GLOBAL_KEY);
    if (!global.success) return { ok: false };
    const client = await extractClientRateLimiter(ctx).limit(args.key);
    return { ok: client.success };
  },
});
