import { Ratelimit, MINUTE } from 'kitcn/ratelimit';
import type { ConvexRatelimitDbWriter } from 'kitcn/ratelimit';
import type { MutationCtx } from '../functions/_generated/server';

// Carries plan 005's Cloudflare `TTS_RATE_LIMITER` binding (wrangler.jsonc,
// 20 requests/minute/client) across into Convex. A cache hit in
// routers/tts.ts never reaches either limiter below -- they only guard the
// path that is about to spend money calling Soniox.
//
// Both are kitcn's standalone `Ratelimit` class pointed at our own
// `ratelimitState` table (schema.ts) via plain `ctx.db` -- not the
// ORM-scaffolded `bunx kitcn add ratelimit` flow / `RatelimitPlugin`, which
// requires the `kitcn/orm` schema system this app does not use. `limit()`
// writes state, so both must be constructed with a *mutation* ctx's `db`
// (see routers/ttsInternal.ts's `consumeTtsRateLimit`) -- neither can be
// called directly from an action.
function dbWriter(ctx: MutationCtx): ConvexRatelimitDbWriter {
  // kitcn's standalone db interface takes a bare `string` table name
  // (`(tableName: string) => ConvexQueryBuilder`) so that it works against
  // any Convex app's schema; the real, code-generated `ctx.db.query`
  // narrows that to this app's actual table-name union, which is a
  // stricter (safe) supertype-in-the-wrong-direction for structural
  // assignability. The cast documents that mismatch instead of hiding it
  // behind `any`.
  return ctx.db as unknown as ConvexRatelimitDbWriter;
}

// Per-client limiter: FAIRNESS ONLY, not a security boundary. `key` is
// caller-supplied (src/lib/storage.ts's getOrCreateClientId -- a
// crypto.randomUUID() sitting in the caller's own localStorage, sent as a
// plain procedure argument). Any script can mint a fresh UUID per request
// and this limiter never fires for it; omitting the id entirely just
// shares the 'anonymous' bucket. It exists only to stop an *honest* client
// from looping (e.g. a UI bug retrying in a tight loop), nothing more. Do
// not rely on this alone -- see ttsGlobalRateLimiter below for the actual
// abuse guard.
export function ttsClientRateLimiter(ctx: MutationCtx) {
  return new Ratelimit({
    db: dbWriter(ctx),
    limiter: Ratelimit.slidingWindow(20, MINUTE),
    prefix: 'tts-client',
  });
}

// Global limiter: the actual security boundary. Keyed on a fixed literal
// (TTS_GLOBAL_KEY) that no request input can influence, so it cannot be
// bypassed by forging a new clientId per request -- unlike the per-client
// limiter above, or plan 005's original Cloudflare limiter, a public
// Convex action has no unforgeable per-caller signal (no trustworthy
// client IP) to key on until plan 008 adds real identity. Rather than fake
// one, this bounds the blast radius instead: 200/min is sized for roughly
// ten concurrent honest readers plus headroom, and caps worst-case
// Soniox/Groq spend even if every single request carries a distinct,
// attacker-forged clientId.
export const TTS_GLOBAL_KEY = 'tts:global';

export function ttsGlobalRateLimiter(ctx: MutationCtx) {
  return new Ratelimit({
    db: dbWriter(ctx),
    limiter: Ratelimit.slidingWindow(200, MINUTE),
    prefix: 'tts-global',
  });
}
