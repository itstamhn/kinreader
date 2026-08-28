# Plan 012: Add a React error boundary, a CSP, and pin Convex to kitcn's supported range

> **Executor instructions**: Follow step by step. Run every verification command. If a
> STOP condition occurs, stop and report — do not improvise.
>
> **Drift check**: `git diff --stat 7e478c5..HEAD -- src/main.tsx src/worker.ts package.json`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/007` (avoids a conflicting `package.json` diff)
- **Category**: dx / security
- **Planned at**: commit `7e478c5`, 2026-08-28

## Why this matters

Three small hardening items, grouped because each is a few lines and none justifies its
own plan.

1. **No error boundary.** `grep -rn "componentDidCatch\|ErrorBoundary" src/` returns
   nothing. Any render-time throw unmounts the entire React tree and the user sees a blank
   page. This is exactly why the plan 001 `Pause` bug was total rather than a broken
   button — a local defect became a whole-app outage.
2. **No Content-Security-Policy.** `src/worker.ts` sets HSTS, `X-Content-Type-Options`,
   `X-Frame-Options` and `Referrer-Policy`, but no CSP. Plan 004 fixed the known XSS by
   escaping; a CSP is the layer that limits damage from the one nobody has found yet.
3. **Convex is outside kitcn's supported range.** `package.json` has `convex@^1.45.0`;
   kitcn 0.32.1 prints `kitcn expects convex >=1.42 <1.45.0; found 1.45.0` on every
   codegen and deploy. It works today. It is an unpinned bet that it keeps working.

## Current state

- `src/main.tsx` — mounts `<App />` inside the provider stack added by plan 006.
- `src/worker.ts:44-47` — where the security headers are set, on every response.
- `package.json` — `"convex": "^1.45.0"`. The caret is what allows the drift.

## Scope

**In scope**: `src/components/ErrorBoundary.tsx` (create), `src/main.tsx`,
`src/worker.ts`, `package.json`, and tests for the boundary.

**Out of scope**: any change to app behaviour, the existing headers, and the provider
wiring itself beyond inserting the boundary.

## Steps

### Step 1: Add the error boundary

Create `src/components/ErrorBoundary.tsx` — a class component (React still requires a
class for `componentDidCatch`) that renders a minimal fallback matching the app's dark
aesthetic, with a "Reload" button that calls `window.location.reload()`. Log the error to
`console.error` so it is not swallowed silently.

Wrap `<App />` in `src/main.tsx`. Place it **outside** the Convex and QueryClient
providers, so it also catches a provider construction failure.

**Verify**: `bun run typecheck` → exit 0; `bun run build` → exit 0.

### Step 2: Add a Content-Security-Policy

In `src/worker.ts`, alongside the existing headers. The SPA is bundled by Vite with no
inline scripts, but it does use inline styles, and it loads remote avatar/OG images:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
connect-src 'self' https://*.convex.cloud https://*.convex.site wss://*.convex.cloud;
media-src 'self' data: blob: https:;
frame-ancestors 'self';
base-uri 'self';
object-src 'none'
```

`connect-src` must permit Convex over both HTTPS and WebSocket, or the reactive client
added in plan 006 breaks. Set it as a single-line header value.

**Do not** apply this CSP to `/api/og`. That response is an SVG image served with its own
content type; a restrictive `default-src` can interfere with how it renders when fetched
directly. Scope the CSP to HTML responses, or exclude the `/api/og` path.

**Verify**: `bunx wrangler dev`, then load `/` and confirm **zero** CSP violations in the
browser console, the app renders, and audio playback still works. Then load
`/api/og?title=Test` and confirm the SVG still renders.

### Step 3: Pin Convex into kitcn's range

```bash
bun add convex@1.44.0
```

**Verify**: `bunx kitcn codegen` no longer prints the version warning. `bun run typecheck`
→ exit 0. `bun test` → all pass. `bunx convex dev --once` deploys.

If pinning to 1.44.0 breaks anything, STOP and report rather than forcing it — the warning
is not worth a broken build.

## Test plan

- A test rendering a child component that throws: the boundary catches it, the fallback UI
  appears, and the rest of the page does not unmount. This must genuinely fail without the
  boundary — verify by temporarily removing it.
- A test that `src/worker.ts` sets the CSP header on an HTML response and does **not** set
  it on `/api/og`.
- Existing tests must keep passing — the boundary must not change normal render output.

## Done criteria

- [ ] `grep -rc "componentDidCatch" src/` returns at least `1`
- [ ] `bun run typecheck` exits 0; `bun test` passes including the boundary test
- [ ] `grep -c "Content-Security-Policy" src/worker.ts` returns at least `1`
- [ ] `bunx kitcn codegen` prints no convex version warning
- [ ] `bun run build` exits 0
- [ ] Manual check: app loads under `wrangler dev` with zero CSP console violations

## STOP conditions

- The CSP breaks the Convex WebSocket connection and you cannot fix it with `connect-src`.
  Report the exact console error — **do not** weaken the policy to `default-src *`, which
  would make it decorative.
- Pinning `convex@1.44.0` breaks typecheck, tests or deploy.
- The error boundary changes what any existing test sees.

## Maintenance notes

- The CSP is the piece most likely to break silently later: any new third-party origin
  (an analytics script, a font host, a new image CDN) needs a matching directive. Whoever
  adds one should check the console before shipping.
- `style-src` allows `'unsafe-inline'` because the app uses inline styles throughout.
  Removing that would be a real hardening step but requires refactoring styles first.
- The boundary is a safety net, not a bug tracker. Consider reporting caught errors
  somewhere durable if this app ever gets real usage.
