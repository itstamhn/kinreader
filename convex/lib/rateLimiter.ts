import { Ratelimit, MINUTE } from 'kitcn/ratelimit';
import type { ConvexRatelimitDbWriter } from 'kitcn/ratelimit';
import type { MutationCtx } from '../_generated/server';

// Carries plan 005's Cloudflare `TTS_RATE_LIMITER` binding (wrangler.jsonc,
// 20 requests/minute/client) across into Convex. A cache hit in
// routers/tts.ts never reaches this -- it only guards the path that is
// about to spend money calling Soniox.
//
// This is kitcn's standalone `Ratelimit` class pointed at our own
// `ratelimitState` table (schema.ts) via plain `ctx.db` -- not the
// ORM-scaffolded `bunx kitcn add ratelimit` flow / `RatelimitPlugin`, which
// requires the `kitcn/orm` schema system this app does not use. `limit()`
// writes state, so this must be constructed with a *mutation* ctx's `db`
// (see routers/ttsInternal.ts's `consumeTtsRateLimit`) -- it cannot be
// called directly from an action.
export function ttsRateLimiter(ctx: MutationCtx) {
  return new Ratelimit({
    // kitcn's standalone db interface takes a bare `string` table name
    // (`(tableName: string) => ConvexQueryBuilder`) so that it works
    // against any Convex app's schema; the real, code-generated
    // `ctx.db.query` narrows that to this app's actual table-name union,
    // which is a stricter (safe) supertype-in-the-wrong-direction for
    // structural assignability. The cast documents that mismatch instead
    // of hiding it behind `any`.
    db: ctx.db as unknown as ConvexRatelimitDbWriter,
    limiter: Ratelimit.slidingWindow(20, MINUTE),
    prefix: 'tts',
  });
}
