# Plan 010: Make magic-link codes unguessable and rate-limit verification attempts

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise.
>
> **Drift check**: `git diff --stat 7e478c5..HEAD -- src/server.ts wrangler.jsonc`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/007-move-tts-to-convex-with-file-storage.md` (to avoid a conflicting `src/server.ts` diff)
- **Category**: security
- **Planned at**: commit `7e478c5`, 2026-08-28

## Why this matters

Two weaknesses compound into one practical attack on the magic-link login.

1. **The code is not cryptographically random.** `src/server.ts:50`:
   ```ts
   const code = Math.floor(100000 + Math.random() * 900000).toString();
   ```
   `Math.random()` is a PRNG, not a CSPRNG. Its output is not designed to be
   unpredictable to an attacker who has observed prior values.

2. **There is no attempt limiting on verification.** `checkRateLimit` exists in
   `src/server.ts` but is wired only to `/api/tts` (plan 005). `POST /api/auth/verify`
   accepts unlimited guesses against a **six-digit** code — a keyspace of 1,000,000 with
   a 15-minute window and no lockout. That is trivially brute-forceable with modest
   concurrency, and each success is a full account takeover.

Either alone is a weakness; together they are a working attack. Plan 003 closed the
*bypass* (the client trusting the URL) but deliberately left both of these open, and said
so.

## Relationship to plan 008

Plan 008 replaces this whole hand-rolled auth surface with Better Auth, deleting the code
generation and the verify endpoint. This plan is therefore **temporary by design** — the
same trade already accepted for plan 003. It is worth doing because 008 is large and this
is small, and the hole is live until 008 ships. Mark 010 SUPERSEDED when 008 lands.

## Current state

- `src/server.ts:50` — the `Math.random()` code generation, inside `/api/auth/magic-link`.
- `src/server.ts` `/api/auth/verify` — reads the record, compares `code` or `token`,
  deletes on success. No attempt counter, no rate limit.
- `AuthRecord` — `{ code, token, expires, name?, avatar? }`, persisted to Workers KV under
  `auth:${email}` with a 900s TTL (plan 003).
- `checkRateLimit(env, key)` — the plan 005 helper. Returns `true` when no binding exists
  (fails open). Reuse it; do not write a second one.
- `wrangler.jsonc` — has one `ratelimits` entry, `TTS_RATE_LIMITER`.

Note: after plan 007 the TTS route and possibly `checkRateLimit`/`TTS_RATE_LIMITER` may
have moved to Convex. If `checkRateLimit` is gone, reinstate the same small helper for
this use rather than inventing a different mechanism.

## Scope

**In scope**: `src/server.ts`, `wrangler.jsonc`, `src/server.test.ts`.

**Out of scope**: the rest of the auth flow (Google OAuth, the magic-link email itself,
`src/lib/autosend.ts`), anything under `convex/`, and the `tier: 'pro'` default.

## Steps

### Step 1: Generate the code with a CSPRNG

Replace the `Math.random()` line with `crypto.getRandomValues`. Avoid modulo bias — do
not simply take `% 900000`:

```ts
function secureSixDigitCode(): string {
  const max = 900000;
  // Largest multiple of `max` that fits in a uint32, so rejection is unbiased.
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0]!;
  } while (n >= limit);
  return (100000 + (n % max)).toString();
}
```

`crypto.getRandomValues` is available in both the Workers runtime and Bun; no import
needed.

**Verify**: `grep -c "Math.random" src/server.ts` → `0`. `bun run typecheck` → exit 0.

### Step 2: Count failed attempts and burn the code

Add `attempts: number` to `AuthRecord`, initialised to `0` when the record is written.

In `/api/auth/verify`, on an **incorrect** code or token:
- increment `attempts` and write the record back (preserving the remaining TTL);
- if `attempts` reaches **5**, delete the record entirely and return the same generic
  `400` error as before.

Deleting on exhaustion means a brute-force attempt costs the attacker the code rather than
letting them keep guessing. The user simply requests a new link.

Keep the error message identical in all failure cases — do not reveal whether the email
was known, whether the code existed, or how many attempts remain.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Add a per-IP limit on verification

Add a second limiter to `wrangler.jsonc`, alongside the existing one:

```jsonc
{ "name": "AUTH_RATE_LIMITER", "namespace_id": "1002", "simple": { "limit": 10, "period": 60 } }
```

`namespace_id` is an arbitrary string unique within the Worker — not an account resource.
`period` accepts only `10` or `60`.

Call the limiter at the top of `/api/auth/verify`, keyed `auth:${cf-connecting-ip}`, and
return `429` with `Retry-After: 60` when denied. Use `cf-connecting-ip`, never
`x-forwarded-for` (client-settable).

**Verify**: `grep -c "AUTH_RATE_LIMITER" wrangler.jsonc` → `1`. `bunx wrangler dev` starts
and logs both limiter bindings.

## Test plan

Extend `src/server.test.ts`, using the existing KV stub pattern:

- A wrong code increments `attempts` without deleting the record (a second, *correct*
  attempt still succeeds — legitimate typos must not lock users out immediately).
- Five wrong attempts delete the record; a subsequent correct code fails.
- The error body is byte-identical for "unknown email", "wrong code" and "expired" — no
  oracle.
- A denied rate limiter returns 429 with `Retry-After: 60`.
- Statistical sanity on the generator: 10,000 codes are all within `100000..999999`, and
  produce at least ~9,000 distinct values (catches a constant or badly-biased generator;
  it is not a randomness test).

## Done criteria

- [ ] `grep -c "Math.random" src/server.ts` returns `0`
- [ ] `bun run typecheck` exits 0; `bun test` passes with the new cases
- [ ] `grep -c "AUTH_RATE_LIMITER" wrangler.jsonc` returns `1`
- [ ] `grep -c "x-forwarded-for" src/server.ts` returns `0`
- [ ] `bun run build` exits 0

## STOP conditions

- `/api/auth/verify` no longer exists in `src/server.ts` — plan 008 has already landed and
  this plan is moot. Report and stop.
- Attempt-counting would require a schema or storage change beyond adding a field to
  `AuthRecord`.
- You find yourself making the error messages *differ* between failure cases. That is an
  enumeration oracle; keep them identical and report if the tests seem to require
  otherwise.

## Maintenance notes

- The five-attempt burn is deliberately aggressive: a legitimate user mistyping a code
  three times is rare, and requesting a new link is cheap. Revisit only with real data.
- `checkRateLimit` fails open by design (a limiter outage should not break login). That is
  acceptable here **because** the attempt counter is enforced in KV independently of the
  limiter — the two are not redundant, they cover each other.
- All of this is deleted by plan 008. Do not build on it.
