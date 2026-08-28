# Plan 009: Retire Spiceflow — move the two markup routes into the Worker and delete `src/server.ts`

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat fa9ed02..HEAD -- src/server.ts src/worker.ts package.json`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: 006, 007, 008 (all three)
- **Category**: tech-debt
- **Planned at**: commit `fa9ed02`, 2026-08-28

## Why this matters

This is the last step of "Convex replaces the Spiceflow backend". After 006, 007 and 008,
`src/server.ts` holds exactly two routes — `GET /api/og` (an SVG card) and `GET /r/:id`
(a share page) — and Spiceflow is a whole HTTP framework carried for two handlers that
return static markup.

These two must **not** move to Convex. They are tied to `kinreader.com`: `/r/:id` is the
URL people paste into X and Slack, and `/api/og` is what those crawlers fetch to render
the card. Convex HTTP actions serve from `<deployment>.convex.site`, and putting them on
the apex domain would need a **Convex Pro plan** for custom domains. Cloudflare already
serves that domain for free, and the operator's scope decision was explicit: Convex
replaces the Spiceflow backend, not the hosting.

So the endgame is not "move everything to Convex" — it is: **data endpoints on Convex,
two presentation routes as plain handlers in the Worker, no HTTP framework at all.**

## Current state (as it will be when this plan runs)

- `src/worker.ts` — the Cloudflare entry point. Line 36 routes `/api` and `/r/` prefixes
  into `app.handle(request)`; everything else is served from `env.ASSETS`. It already
  does HTTPS redirection and sets HSTS, `nosniff`, `X-Frame-Options` and `Referrer-Policy`.
- `src/server.ts` — after 006/007/008, only `/api/og` (currently at line 679) and
  `/r/:id` (line 780) remain, plus the helpers `round`, `escapeHtml`, `safeImageUrl` and
  `arrayBufferToBase64`.
- `escapeHtml` and `safeImageUrl` are load-bearing security code from plan 004. They move
  with the routes. **Their tests move too, and must keep passing.**
- `arrayBufferToBase64` was only used by the TTS route; after 007 it is probably dead.
- `spiceflow` is a runtime dependency in `package.json`.

## Scope

**In scope**: `src/worker.ts`, `src/server.ts` (delete), `src/server.test.ts` (retarget at
the Worker), `package.json` (drop `spiceflow`), `vite.config.ts` (the `/api` dev proxy may
no longer be needed).

**Out of scope**: any behavioural change to the two routes. The HTML and SVG output must
be byte-identical for identical input — this is a plumbing change. Also out of scope: the
security headers in `src/worker.ts`, and any Convex work.

## Steps

### Step 1: Reimplement the two routes as plain handlers

Add a small router to `src/worker.ts` — a `URL` parse plus two branches is enough; do not
introduce another framework. Move `escapeHtml`, `safeImageUrl` and `round` across
unchanged. Preserve the exact response headers, including
`Content-Type: image/svg+xml` and `Cache-Control: public, max-age=86400` on `/api/og`,
and `text/html; charset=utf-8` on `/r/:id`.

`/r/:id` currently gets its `id` from Spiceflow's `params`. Parse it from the pathname
instead, and keep the existing `encodeURIComponent(id)` on the way into the refresh URL.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Retarget the tests at the Worker

`src/server.test.ts` drives `app.handle(...)`. Point the surviving tests at the Worker's
`fetch` export. **Every plan 004 XSS test must survive this move and still pass** — they
are the regression suite for a real vulnerability.

**Verify**: `bun test` → all pass, with the XSS cases present and passing.

### Step 3: Delete `src/server.ts` and drop the dependency

```bash
rm src/server.ts
bun remove spiceflow
```

Check whether `vite.config.ts`'s `/api` → `localhost:3008` proxy and the `dev:api` /
`start` scripts in `package.json` still make sense; the standalone Bun server at the
bottom of `src/server.ts` disappears with the file.

**Verify**: `grep -rc "spiceflow" src/ package.json` → `0`. `bun run typecheck` → exit 0.
`bun test` → all pass. `bun run build` → exit 0.

### Step 4: Confirm the deployed shape

Run `bunx wrangler dev` and check by hand:
- `/` serves the SPA.
- `/api/og?title=Hello` returns SVG with `Content-Type: image/svg+xml`.
- `/r/x?t=Hello` returns the share HTML.
- `/api/og?title=<script>alert(1)</script>` is still escaped.

**Verify**: all four hold, and the escaping check shows no raw `<script>`.

## Test plan

- All plan 004 XSS cases, retargeted and passing — the non-negotiable part.
- `/` returns the SPA shell (asset path still works).
- A request to a removed route (`/api/extract`, `/api/tts`, `/api/auth/verify`) returns
  404 rather than 500, confirming clean removal.
- No live network calls.

## Done criteria

- [ ] `src/server.ts` no longer exists
- [ ] `grep -rc "spiceflow" src/ package.json` returns `0`
- [ ] `bun run typecheck` exits 0; `bun test` passes with the XSS suite intact
- [ ] `bun run build` exits 0
- [ ] `wrangler dev` serves SPA, `/api/og` and `/r/:id` correctly

## STOP conditions

Stop and report if:

- Any plan 004 XSS test cannot be made to pass against the Worker. **Do not delete or
  weaken a security test to finish this plan** — a plumbing change is never worth losing
  regression coverage for a real vulnerability.
- Removing Spiceflow changes the response bytes for identical input.
- `src/server.ts` still contains routes other than `/api/og` and `/r/:id` — that means
  006, 007 or 008 has not fully landed. Report which routes remain and stop.
- Static asset serving breaks under `wrangler dev`.

## Maintenance notes

- End state: Cloudflare owns the domain, the static SPA, and two presentation routes;
  Convex owns all data, auth and provider calls. One HTTP framework fewer, and no
  Convex Pro plan required.
- If the share page ever needs real article data (today `/r/:id` renders only query-string
  values and cannot actually resolve a shared article — a known product gap), that Worker
  handler can call Convex server-side. That is a feature, not part of this cleanup.
- Revisit whether `dev:api` and `start` still belong in `package.json` once the standalone
  Bun server is gone.
