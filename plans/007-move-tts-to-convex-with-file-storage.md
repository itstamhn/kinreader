# Plan 007: Move `/api/tts` to a Convex action backed by Convex file storage

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat fa9ed02..HEAD -- convex/ src/server.ts src/App.tsx src/utils/speechEngine.ts src/lib/storage.ts`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/006-wire-kitcn-and-move-extract-to-convex.md`
- **Category**: migration / cost
- **Planned at**: commit `fa9ed02`, 2026-08-28

## Why this matters

Two wins in one move. First, it removes the second-largest chunk of the Spiceflow
backend. Second — and this is the real prize — it makes generated audio **cacheable
across sessions**. Today `src/lib/storage.ts:88` caches audio in `sessionStorage`, so
every tab close throws it away and the next read re-bills Soniox **and** Groq for audio
that was already synthesised. `convex/schema.ts:36` already models `audioTracks` keyed by
`articleId + voice + speed` with a `storageId` field, purpose-built for this and unused.

A server-side cache reduces spend far more than plan 005's rate limit does. 005 caps the
bleeding; this closes the wound.

## Read this before writing code — the constraint that shapes the whole plan

**Convex values are capped at 1MB.** The current endpoint returns `audioBase64` inline
(`src/server.ts:~560`). A 4000-character article is roughly 4 minutes of speech; as MP3
that is ~2MB, and base64 inflates it by a further third. **Returning audio inline from a
Convex action will exceed the limit and throw.**

The audio must go through Convex file storage:

- `ctx.storage.store(blob)` — Convex storage stores `Blob` objects; convert to and from
  `Blob` at the boundary.
- `ctx.storage.getUrl(storageId)` returns a signed URL, or `null` if the file is gone.
- Do **not** use the deprecated `ctx.storage.getMetadata`; query the `_storage` system
  table via `ctx.db.system.get("_storage", id)` if you need size or content type.
- Never use `ctx.db` inside an action — go through `ctx.runMutation`.

The `words` array has its own ceiling: **arrays may hold at most 8192 elements**. A very
long article can exceed that. Cap it and record that the timing track was truncated,
rather than letting the mutation throw.

## Carrying the rate limit across — do not drop it

Plan 005 protects `/api/tts` with a **Cloudflare** rate-limiter binding
(`wrangler.jsonc` `ratelimits`, `src/server.ts` `checkRateLimit`). That binding does not
exist inside Convex. Moving the endpoint without replacing the limiter silently reopens
the abuse hole that 005 closed.

Use the `@convex-dev/rate-limiter` component. Install it per the current Convex
component docs — do not guess the API. The limit should match what 005 chose: **20 paid
synthesis calls per minute**, keyed per user once plan 008 lands, and until then keyed on
whatever stable client identifier is available.

The cache changes the economics here: a cache hit costs nothing, so the limiter only
needs to guard cache **misses**. Check the cache first, then rate-limit only when you are
about to call Soniox.

## Current state

- `src/server.ts:469` — the `/api/tts` handler, with three provider branches (Soniox+Groq,
  ElevenLabs, browser fallback) plus the 005 guards (`MAX_TTS_CHARS`, `willCallPaidProvider`).
- `src/App.tsx:166-205` — the client call. On any non-2xx it falls through to
  `engine.loadBrowserText(...)` at line 204. **Preserve that fallback.**
- `src/utils/speechEngine.ts` — `loadAudio(audioBase64, words, duration)` takes base64.
  Moving to a URL means this signature changes; that is expected work, not scope creep.
- `src/lib/storage.ts:88` — `cacheArticleAudio` writes to `sessionStorage`.
- `convex/schema.ts:36-56` — the `audioTracks` table, with
  `by_article_voice_speed` and `by_article` indexes. Already correct; do not redesign it.

## Commands you will need

| Purpose    | Command                   | Expected on success |
|------------|---------------------------|---------------------|
| Typecheck  | `bun run typecheck`       | exit 0, no output   |
| Tests      | `bun test`                | all pass            |
| Build      | `bun run build`           | exit 0              |
| Convex dev | `bunx convex dev --once`  | deploys             |
| Convex env | `bunx convex env set ...` | key stored          |

## Scope

**In scope**: `convex/` (a new TTS router/action, component config), `src/App.tsx` (the
TTS call), `src/utils/speechEngine.ts` (audio loading), `src/lib/storage.ts` (retire the
sessionStorage audio cache), `src/server.ts` (remove the `/api/tts` route **last**),
`wrangler.jsonc` (remove the now-unused `ratelimits` block **only after** the Convex
limiter is proven), tests.

**Out of scope**: `/api/auth/*` (plan 008), `/r/:id` and `/api/og` (plan 009),
`convex/routers/users.ts`, any change to the reader UI or kinetic display, and the
ElevenLabs provider — it is dead in production anyway (`src/server.ts:588` reads
`process.env` where Workers secrets never appear). Port Soniox + Groq + the browser
fallback; drop ElevenLabs and say so in your report.

## Steps

### Step 1: Set the provider keys in the Convex environment

`bunx convex env set SONIOX_API_KEY <value>` and the same for `GROQ_API_KEY`. Never print
or commit the values. **Verify**: `bunx convex env list` includes both names; report only
their presence.

### Step 2: Install and configure the rate limiter component

Follow the current `@convex-dev/rate-limiter` docs. 20 per minute, matching plan 005.

**Verify**: `bunx convex dev --once` deploys with the component registered.

### Step 3: Write the TTS action

Order of operations inside the action, and this order is load-bearing:

1. Look up `audioTracks` by `articleId + voice + speed`. On a hit, return the stored
   `storageId`'s URL and `words` — **no rate limit consumed, no provider called**.
2. On a miss, consume a rate-limit token. If denied, return a result the client can still
   use for browser-speech fallback — not an error the player cannot recover from.
3. Call Soniox; convert the response to a `Blob`; `ctx.storage.store(blob)`.
4. Call Groq for word timings; fall back to linear distribution exactly as
   `src/server.ts` does today. Cap `words` at 8192 entries.
5. `ctx.runMutation` to insert the `audioTracks` row (actions cannot touch `ctx.db`).
6. Return `{ audioUrl, words, duration, provider, cached: boolean }`.

**Verify**: `bun run typecheck` exits 0; `bunx convex dev --once` deploys.

### Step 4: Use the URL loader the engine already has

**Verified at plan-revision time: `SpeechEngine.loadAudioUrl(url, words, duration)`
already exists at `src/utils/speechEngine.ts:141`** and is already used for the sample
article (`src/App.tsx:119` and `:142`). Do **not** add a new method or change
`loadAudio`'s signature — switch the call site at `src/App.tsx:191` from `loadAudio(...)`
to `loadAudioUrl(...)` with the signed Convex storage URL.

Keep `loadBrowserText` untouched — it is the fallback path and must keep working.

**Verified call sites** (checked before this plan was dispatched — `/api/tts` has exactly
one client caller, unlike `/api/extract` which had three):
- `src/App.tsx:173` — the only `fetch('/api/tts')` in the codebase.
- `src/App.tsx:147` and `:192` — `getCachedArticleAudio` / `cacheArticleAudio`, the
  sessionStorage cache this plan retires.
- `src/App.tsx:151` and `:191` — the two `loadAudio(base64, ...)` calls. Line 151 is the
  sessionStorage-cache path, which goes away with the cache.

**Verify**: `bun test` passes, including a new engine test.

### Step 5: Switch the client and preserve the fallback

Update `src/App.tsx` to call the Convex action. The `if (res.ok)`-equivalent guard and the
`engine.loadBrowserText(...)` fallback at line 204 must survive in spirit: any failure —
rate limited, provider down, network error — still yields working on-device playback.

Retire the `sessionStorage` audio cache in `src/lib/storage.ts` once the server cache is
proven; leave the *article* library functions alone (plan 008 owns those).

**Verify**: `bun test` passes; `grep -c "api/tts" src/App.tsx` → `0`.

### Step 6: Remove the Spiceflow TTS route and the Cloudflare limiter

Only now delete `.post('/api/tts', ...)` from `src/server.ts`, plus the
`checkRateLimit` helper and the `ratelimits` block in `wrangler.jsonc` if nothing else
uses them.

**Verify**: `grep -c "'/api/tts'" src/server.ts` → `0`; `bun test` passes;
`bun run build` exits 0.

## Test plan

- Cache hit returns without calling any provider (stub `fetch`; assert it was not called).
- Cache miss stores a file and inserts exactly one `audioTracks` row.
- A second identical request hits the cache (assert one stored file, not two).
- Rate-limit denial on a cache miss still returns a client-usable result.
- A `words` array over 8192 entries is capped, not thrown.
- No live network calls anywhere in the suite.
- **Import `api` from `convex/shared/api.ts`, not `convex/_generated/api`.** Learned in
  plan 006: Convex's own generated `api` type filters kitcn procedures out entirely,
  because `FilterApi` does not recognise kitcn's wrapped `Procedure` as a
  `RegisteredAction`. The function deploys and runs fine; only the generated *type*
  omits it.

## Done criteria

- [ ] `bun run typecheck` exits 0 and `bun test` passes
- [ ] `grep -c "'/api/tts'" src/server.ts` returns `0`
- [ ] A repeat request for the same article/voice/speed performs zero provider calls
- [ ] Rate limiting is enforced by the Convex component (demonstrated by a test)
- [ ] `bun run build` exits 0

## STOP conditions

Stop and report if:

- You find yourself returning audio bytes or base64 through a Convex value. That hits the
  1MB limit — the file must go through `ctx.storage`.
- The rate limiter cannot be made to work. **Do not delete the Cloudflare limiter and
  ship without a replacement** — that silently undoes plan 005. Leave `/api/tts` on the
  Worker and report.
- The client's browser-speech fallback cannot be preserved.
- Removing the audio `sessionStorage` cache degrades a real user flow you can demonstrate.

## Maintenance notes

- After this, the cost profile changes completely: repeat reads are free. Whoever tunes
  the rate limit next should tune it against **cache misses**, which is the only path
  that costs money.
- ElevenLabs support is dropped here deliberately. If it is ever wanted back, it needs
  the `env`-vs-`process.env` bug fixed as part of that work.
- `audioTracks` rows hold a `storageId`. Deleting a row without deleting the stored file
  leaks storage — whoever adds cache eviction must delete both.
