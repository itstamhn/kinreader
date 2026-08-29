# Plan 009: Delete Spiceflow — every backend route lives on Convex

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise.
>
> **Revised 2026-08-29 at commit `f5e5210`.** The original was written when `src/server.ts`
> still held `/api/og` and `/r/:id` and planned to keep them in the Worker. Plan 014 moved
> both to the Astro app on the apex, so this plan is now smaller and its goal is absolute:
> **no application backend outside Convex.**
>
> **Drift check (run first)**: `git diff --stat f5e5210..HEAD -- apps/web/src/server.ts apps/web/src/worker.ts apps/web/wrangler.jsonc`

## Status

- **Priority**: P3
- **Effort**: S (it is a deletion — the work is in 008)
- **Risk**: MED (removes the last hand-rolled auth surface; nothing may still call it)
- **Depends on**: `plans/008` — this cannot start until auth is on Convex
- **Category**: tech-debt
- **Planned at**: commit `fa9ed02`, revised at `f5e5210`

## Why this matters

The backend is spread across two runtimes for no remaining reason. Convex already owns
article extraction (006) and TTS (007). Astro owns the two markup routes (014). What is
left in Spiceflow is auth and a health check:

```
apps/web/src/server.ts
  GET  /api/health                    ← a liveness probe for a Worker that will not exist
  POST /api/auth/magic-link           ─┐
  POST /api/auth/verify                │  plan 008 moves all four
  GET  /api/auth/google                │  to Convex + Better Auth
  GET  /api/auth/google/callback      ─┘
```

Once 008 lands, `server.ts` is an HTTP framework, a KV binding and a rate limiter carried
for one health check. Deleting it is the point where "Convex is the API for every client"
stops being an aspiration and becomes true — which is also what unblocks the mobile app
(017) from having anything web-shaped to work around.

## Current state

- `apps/web/src/server.ts` — the five routes above, plus the KV auth-record helpers, the
  OAuth state-cookie helpers, `canonicalOrigin`, and the rate-limit wrapper.
- `apps/web/src/worker.ts` — four jobs: the HTTP→HTTPS redirect, routing `/api` into
  Spiceflow, serving static assets, and attaching security headers.
- `apps/web/wrangler.jsonc` — `AUTH_CODES` KV namespace, `AUTH_RATE_LIMITER`, and
  `APP_ORIGIN`, all of which exist only for auth.
- `apps/web/src/lib/autosend.ts` — sends the magic-link email; called only from
  `server.ts`.
- `package.json` — `spiceflow` and `zod` as dependencies of `@kinreader/web`.

## Scope

**In scope**: deleting `server.ts`, the Spiceflow dependency, the auth-only bindings, and
whatever in `worker.ts` becomes dead.

**Out of scope**:

- Moving auth. That is plan 008 and it must be finished and verified first.
- The Astro app's routes. They are not Spiceflow and not affected.
- Changing what the security headers say. Where they are set may change (see Step 3);
  what they contain does not.

## Steps

### Step 1: Confirm nothing still calls it

```bash
grep -rn "/api/auth" apps/ packages/          # expect: nothing outside tests
grep -rn "/api/health" apps/ packages/        # expect: only server.ts + its test
```

If anything in `apps/web/src` still calls `/api/auth/*`, **008 is not actually finished** —
stop and go back to it. This grep is the gate, not a formality: a missed call site becomes
a 404 in production and nowhere else, which is the exact failure plan 006 hit.

### Step 2: Delete

- `apps/web/src/server.ts` and `apps/web/src/server.test.ts`
- `apps/web/src/lib/autosend.ts`, unless 008 kept it for Better Auth's mailer — check
  before deleting
- `spiceflow` from `apps/web/package.json` (keep `zod` if anything else uses it — grep)
- `AUTH_CODES`, `AUTH_RATE_LIMITER` and `APP_ORIGIN` from `wrangler.jsonc`

`/api/health` goes with the file. It reports on a Worker that is about to stop having a
backend; Convex has its own health surface.

**Verify**: `bun run typecheck` exits 0. `bun run test` passes — with a smaller count, and
the drop should equal exactly the tests in `server.test.ts`.

### Step 3: Decide what the Worker is still for

With `/api` gone, `worker.ts` has one job left that the platform does not already do:
the HTTP→HTTPS redirect. Everything else is already handled elsewhere —

- **Security headers**: `public/_headers` sets them, and plan 012 established that
  Cloudflare serves matching assets **without invoking the Worker at all**, so the
  Worker's copy has never applied to the page load.
- **Asset serving**: `assets.directory` does it.

So there are two honest options, and this plan does not pre-judge which:

**(a) Keep a minimal Worker** for the HTTPS redirect and any future edge logic. Smallest
diff, one file that does one thing.

**(b) Drop the Worker script entirely** — assets-only, with `_headers` carrying the
headers and Cloudflare's Always Use HTTPS setting doing the redirect. Fewer moving parts
and no Worker invocations to pay for, but it moves one behaviour from code into dashboard
configuration, where it is invisible to this repo.

Pick one, write down which and why. **If (b): verify the redirect works from a real
`http://` request before removing the Worker**, not after.

**Verify**: `bunx wrangler deploy --dry-run` exits 0. `curl -sI http://app.kinreader.com/`
still redirects to HTTPS.

### Step 4: Prune the docs

`CLAUDE.md`, `README.md` and `plans/README.md` all describe `apps/web` as "the Vite SPA and
the Cloudflare Worker (auth, share routes)". After this it is the SPA, plus at most a
redirect shim. Say so, and say where the backend is instead.

**Verify**: `grep -rn "Spiceflow" --include=*.md .` finds only historical references in
`plans/` — which stay, because the log is a record of what happened.

## Test plan

Nothing new to test; the suite shrinks. What matters is that the shrink is *exactly* the
`server.test.ts` cases and nothing else went quiet. Note the count before and after and
check the difference.

Keep the straggler guard in whatever form survives — the test that no file under
`apps/web/src` references a route that has moved away. It has already caught two real
mistakes in this repo (plans 006 and 014).

## Done criteria

- [ ] `grep -rn "spiceflow" apps/ packages/` returns nothing outside `plans/`
- [ ] `apps/web/src/server.ts` is gone
- [ ] No auth-only bindings remain in `wrangler.jsonc`
- [ ] The Worker decision from Step 3 is written down in this file's log entry
- [ ] `bun run typecheck`, `bun run test`, `bun run build` clean
- [ ] `bunx wrangler deploy --dry-run` exits 0
- [ ] HTTP still redirects to HTTPS in production

## STOP conditions

- Step 1's grep finds a live caller. Go finish 008.
- Deleting `AUTH_CODES` would destroy data someone still needs. It holds short-lived
  magic-link records with a 15-minute TTL, so this should be nothing — **confirm the
  namespace is empty rather than assuming it.**
- Option (b) is chosen and the HTTPS redirect cannot be verified before the Worker is
  removed. Ship (a) instead; a redirect that silently stops working is worse than a Worker
  that does almost nothing.

## Maintenance notes

- After this, **every application backend concern is a Convex function.** The Worker, if it
  survives, serves bytes and redirects protocols. That invariant is what makes a second and
  third client cheap (017), so a future "just one small endpoint in the Worker" is the
  thing to push back on.
- The magic-link flow, the OAuth state cookie and the KV-backed token store were built over
  plans 003, 010 and the mobile-sign-in fix, and all of it is deleted here. That work was
  not wasted — it kept sign-in working for the months before Convex owned auth — but none
  of it should be resurrected. Better Auth owns this now.
