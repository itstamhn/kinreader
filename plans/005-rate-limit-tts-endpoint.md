# Plan 005: Rate-limit `/api/tts` so strangers cannot spend your Soniox and Groq credits

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2477929..HEAD -- src/server.ts wrangler.jsonc src/worker.ts`
> If any of those changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-establish-verification-baseline.md`
- **Category**: security / cost
- **Planned at**: commit `2477929`, 2026-08-28

## Why this matters

`POST /api/tts` (`src/server.ts:446`) is unauthenticated, unmetered, and — since commit
`2477929`, "make neural narrator built-in and remove api key configuration from UI" —
runs on **the operator's own** Soniox and Groq keys read from the Worker environment
(`src/server.ts:459`). Before that commit users supplied their own keys, so abuse cost
them, not you. That changed, and nothing else changed with it.

Today anyone who finds kinreader.com can POST unlimited requests. Each one triggers a
Soniox TTS synthesis and a Groq Whisper transcription. `text` is capped at 4000
characters per request (`src/server.ts:494`), but the number of requests is not capped
at all, and there is no per-IP accounting. A trivial loop turns your API budget into
someone else's free TTS service. There is no spend alarm in this repo to catch it.

The fix is a per-IP rate limit at the edge, plus an explicit request-size cap so a
single request cannot be arbitrarily expensive.

## Current state

- `src/server.ts:446-676` — the `/api/tts` handler. Three provider branches: Soniox +
  Groq (also the `browser` default), ElevenLabs, and a pure-browser fallback that costs
  nothing.
- `src/server.ts:459` — where the handler reads the environment:
  ```ts
        const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
  ```
- `src/server.ts:494` — `text.slice(0, 4000)` caps what is *sent* to Soniox, but the
  handler accepts any size body before that.
- `src/worker.ts:38` — `(request as any).env = env;` is the only place bindings are
  attached, and it happens for every `/api` request.
- `wrangler.jsonc` — has `assets` and `routes`; no `ratelimits` block.

The entry point of the handler as it exists today:

```ts
// src/server.ts:446-459
  .post('/api/tts', async ({ request }) => {
    try {
      const body = await request.json();
      const text = body.text?.trim();
      const provider = body.provider || 'browser';

      if (!text) {
        return new Response(JSON.stringify({ error: 'Text is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
```

Note: after plan 002, line 448 reads `const body = (await request.json()) as TtsBody;`.
Expect that, not the excerpt above.

Repo conventions that apply here:

- Error responses: `new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } })`.
- Bindings are read off `(request as any).env`, never imported.
- Config lives in `wrangler.jsonc` (JSONC — comments are allowed).

Cloudflare Workers rate-limiting facts you will need (from Cloudflare's current docs —
do not guess the API):

- Configure in `wrangler.jsonc`:
  ```jsonc
  "ratelimits": [
    { "name": "TTS_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 20, "period": 60 } }
  ]
  ```
- `namespace_id` is an arbitrary string you choose, unique per limiter within the
  Worker. It is **not** an account resource — there is no `wrangler` command to create
  one, and nothing to look up.
- `period` accepts only `10` or `60` (seconds).
- Usage: `const { success } = await env.TTS_RATE_LIMITER.limit({ key });` — `key` is any
  string. Calling `limit()` is what increments the counter.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Install   | `bun install`       | exit 0              |
| Typecheck | `bun run typecheck` | exit 0, no output   |
| Tests     | `bun test`          | all pass            |
| Build     | `bun run build`     | exit 0              |
| Local run | `bunx wrangler dev` | serves on localhost |

`typecheck` and `test` exist only after plan 002. If they are missing, STOP.

## Scope

**In scope**:
- `wrangler.jsonc` (add the `ratelimits` block)
- `src/server.ts` (the `/api/tts` handler and one new helper)
- `src/server.test.ts` (extend — created by plan 002)

**Out of scope** (do NOT touch, even though they look related):
- **Do not add authentication to `/api/tts`.** Requiring sign-in changes the product —
  anonymous listening is the current front-door experience. Rate limiting is the fix
  that does not.
- `/api/extract` and `/api/auth/magic-link`, which have the same exposure. They are
  worth limiting too, but each needs its own limit tuned to its own cost, and bundling
  them makes this diff hard to reason about. Listed as follow-ups below.
- The provider branches themselves — Soniox request shape, Groq alignment, the
  ElevenLabs path, the browser fallback timing maths. None of that changes.
- Caching of generated audio. Server-side caching would cut cost far more than rate
  limiting does, but it needs the `audioTracks` table in `convex/schema.ts:36` to be
  wired up, which is a much larger piece of work.
- Any spend alerting or budget cap on the Soniox/Groq side — that is account
  configuration, not code.

## Git workflow

- Branch: `advisor/005-rate-limit-tts`
- Conventional Commits. Suggested: `feat(security): rate-limit /api/tts per client IP`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Declare the rate limiter binding

Add to `wrangler.jsonc`, as a sibling of the existing `"assets"` key:

```jsonc
  "ratelimits": [
    {
      "name": "TTS_RATE_LIMITER",
      "namespace_id": "1001",
      // 20 synthesis requests per minute per client IP
      "simple": { "limit": 20, "period": 60 }
    }
  ],
```

20/minute is comfortably above real reading use (one request per article, occasionally
re-requested on voice or speed change) and far below what makes abuse worthwhile. If the
operator has said otherwise, use their number.

**Verify**: `grep -c "TTS_RATE_LIMITER" wrangler.jsonc` → `1`.

### Step 2: Add a rate-limit helper that fails open only when unbound

At the bottom of `src/server.ts`, with the other helpers:

```ts
async function checkRateLimit(env: any, key: string): Promise<boolean> {
  // No binding (local `bun src/server.ts`, or tests) — allow.
  if (!env?.TTS_RATE_LIMITER) return true;
  try {
    const { success } = await env.TTS_RATE_LIMITER.limit({ key });
    return success;
  } catch {
    // Limiter unavailable — allow rather than break playback.
    return true;
  }
}
```

Failing open is deliberate and worth understanding before you change it: the limiter is
a cost control, not an access control, and a limiter outage should not take down the
product. It is safe here **only because** Step 3 also caps request size, so the
worst case during an outage is bounded per request.

**Verify**: `bun run typecheck` → exit 0, no output.

### Step 3: Enforce the limit and a size cap in the handler

Two guards, inserted in the `/api/tts` handler. Both must sit **after** the `env` line
at `src/server.ts:459` and **before** any provider branch.

First, reject oversized bodies outright rather than silently truncating:

```ts
      const MAX_TTS_CHARS = 4000;
      if (text.length > MAX_TTS_CHARS) {
        return new Response(
          JSON.stringify({ error: `Text exceeds the ${MAX_TTS_CHARS} character limit` }),
          { status: 413, headers: { 'Content-Type': 'application/json' } }
        );
      }
```

Then apply the limit — but **only to the branches that spend money**. The browser
fallback is free and must stay unlimited, otherwise a rate-limited user loses playback
entirely instead of degrading to on-device speech:

```ts
      const sonioxApiKeyPresent = Boolean(body.sonioxApiKey || env.SONIOX_API_KEY);
      const willCallPaidProvider =
        provider === 'elevenlabs' || ((provider === 'soniox' || provider === 'browser') && sonioxApiKeyPresent);

      if (willCallPaidProvider) {
        const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
        const allowed = await checkRateLimit(env, `tts:${clientIp}`);
        if (!allowed) {
          return new Response(
            JSON.stringify({ error: 'Rate limit exceeded. Please try again in a minute.' }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } }
          );
        }
      }
```

Use `cf-connecting-ip`. Do **not** use `x-forwarded-for` — it is client-settable and
trivially spoofed, which would make the limit decorative.

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `grep -c "cf-connecting-ip" src/server.ts` → `1`.

**Verify**: `grep -c "x-forwarded-for" src/server.ts` → `0`.

### Step 4: Confirm the client degrades gracefully (already verified — do not change it)

The client already handles a non-2xx `/api/tts` response correctly. `src/App.tsx:181`
guards the success path with `if (res.ok)`, and anything else falls through to
`engine.loadBrowserText(art.content, initialWordTimings)` at `src/App.tsx:204`:

```tsx
// src/App.tsx:181-204 (abridged)
      if (res.ok) {
        const data = await res.json();
        if (data.audioBase64 && data.words && data.words.length > 0) {
          // ... use neural audio, then return
        }
      }
    } catch (err) {
      console.warn('Soniox neural synthesis fallback:', err);
    }

    // 3. Fallback to device speech only if offline or synthesis fails
    engine.loadBrowserText(art.content, initialWordTimings);
```

So a 429 surfaces to the user as on-device speech, not as a broken player. This is
confirmed, not an assumption — **make no change to `src/App.tsx` in this plan.** Your
only job here is to not break that property.

Note the client sends `provider: 'soniox'` explicitly (`src/App.tsx:173`), so it takes
the paid branch whenever a Soniox key is configured. That is the branch Step 3 limits.

**Verify**: `grep -n "loadBrowserText" src/App.tsx` → still present at the fallback site.

**Verify**: `bun test` → all pass.

## Test plan

Extend `src/server.test.ts` (created by plan 002). Drive `app.handle` directly and
attach a stub limiter via `(request as any).env`.

- **Over-size**: POST `/api/tts` with `text` of 5000 characters → 413, and the response
  body contains `error`.
- **At the boundary**: 4000 characters → not 413.
- **Limited**: stub `env.TTS_RATE_LIMITER.limit` to return `{ success: false }`, with
  `env.SONIOX_API_KEY` set and a `cf-connecting-ip` header → 429, and the `Retry-After`
  header is `60`.
- **Allowed**: stub `limit` to return `{ success: true }` → not 429.
- **Free path is never limited**: stub `limit` to return `{ success: false }` but with
  **no** `SONIOX_API_KEY` in env → 200 with `provider: 'browser'`. This is the
  regression test for Step 3's most important detail.
- **Fails open**: stub `limit` to throw → the request proceeds (not 429).
- **No binding**: `env` without `TTS_RATE_LIMITER` → the request proceeds.

Model on the `/api/tts` cases plan 002 added to the same file.

Verification: `bun test` → all pass, including at least 7 new cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0 with no output
- [ ] `bun test` exits 0, including the free-path-never-limited case
- [ ] `grep -c "TTS_RATE_LIMITER" wrangler.jsonc` returns `1`
- [ ] `grep -c "cf-connecting-ip" src/server.ts` returns `1`
- [ ] `grep -c "x-forwarded-for" src/server.ts` returns `0`
- [ ] `grep -c "429" src/server.ts` returns at least `1`
- [ ] `bun run build` exits 0
- [ ] `git status --short` shows only `wrangler.jsonc`, `src/server.ts` and
      `src/server.test.ts` modified
- [ ] `plans/README.md` status row for 005 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `bun run typecheck` or `bun test` does not exist — plan 002 has not landed.
- The `/api/tts` handler no longer matches "Current state" (allowing for plan 002's
  `as TtsBody` cast on line 448).
- The `if (res.ok)` guard at `src/App.tsx:181` or the `loadBrowserText` fallback at
  `src/App.tsx:204` is gone. Those two lines are what make a 429 safe to return; without
  them this change turns a cost control into an outage. Report it and stop.
- `wrangler dev` rejects the `ratelimits` config. Report the exact error rather than
  guessing at the schema — `period` in particular accepts only `10` or `60`.
- You are tempted to add auth to `/api/tts` to make limiting easier. That is explicitly
  out of scope; report the reasoning instead.
- Adding the limit appears to require changes inside a provider branch. It does not —
  both guards sit above all three branches.

## Maintenance notes

- The limiter keys on `cf-connecting-ip`, so it does nothing for a distributed abuser
  and it shares a bucket across users behind one NAT. It is the cheap 80% control. If
  abuse continues, the next step is a signed client token or per-account quota — which
  needs the auth work in plan 003 to have landed.
- **Follow-ups deliberately not included here**, each still open: `/api/extract` is
  equally unauthenticated and makes outbound fetches to arbitrary URLs on your Worker's
  behalf; `/api/auth/magic-link` can be driven to send unlimited emails through your
  AutoSend account. Both want their own limiter with their own budget.
- The much larger cost win is caching: audio is currently regenerated from scratch every
  session because `src/lib/storage.ts` caches it in `sessionStorage` only. The
  `audioTracks` table in `convex/schema.ts:36` is already modelled and keyed by
  `articleId + voice + speed` for exactly this, and unused. Plan that next — it reduces
  both spend and latency, and it shrinks the blast radius this plan is defending.
- A reviewer should check one thing above all: that a rate-limited request still returns
  usable word timings via the browser branch rather than an error the player cannot
  recover from.
