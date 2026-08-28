# Plan 006: Wire the kitcn cRPC layer and move `/api/extract` to a Convex action

> **Executor instructions**: Follow this plan step by step. Run every verification
> command and confirm the expected result before moving on. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. When done, update the
> status row for this plan in `plans/README.md` — unless a reviewer told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat fa9ed02..HEAD -- convex/ src/server.ts src/main.tsx src/App.tsx`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/002-establish-verification-baseline.md` (DONE)
- **Category**: migration
- **Planned at**: commit `fa9ed02`, 2026-08-28

## Why this matters

The repo carries a full kitcn + Convex installation that does nothing. `convex/crpc.ts`
exports cRPC builders (`router`, `query`, `mutation`, `action`), but neither router file
uses them — `convex/routers/articles.ts:2` and `convex/routers/users.ts:1` import
`mutation`/`query` straight from `../_generated/server`. The consequence is visible in
two generated files: `convex/generated/procedure-names.gen.ts` contains
`export const procedureNames = {};` and `convex/shared/api.ts` exports
`api = { _http: {} }`. kitcn's codegen has found zero procedures, so the typed client
surface is empty and the frontend cannot call any of it.

Meanwhile `@tanstack/react-query` is a dependency that no file imports, and
`convex/routers/articles.ts` exports `extractArticle` as a plain async function that
nothing calls — a dead duplicate of the extraction logic in `src/server.ts:229`.

This plan is phase 1 of replacing the Spiceflow backend with Convex. It wires the cRPC
layer, proves the path end-to-end with one endpoint (`/api/extract`), and leaves the
Worker serving static assets exactly as it does today. It deliberately moves **one**
endpoint so that the wiring is verified before TTS (plan 007) and auth (plan 008)
depend on it.

**Scope boundary set by the operator**: Convex replaces the *Spiceflow backend only*.
Cloudflare Workers keeps serving `dist/` and keeps owning `kinreader.com`. This is not
a move to Convex hosting — Convex custom domains require a Pro plan, and nothing here
needs one.

## Current state

- `convex/crpc.ts` — the cRPC entry point, 11 lines:
  ```ts
  import { initCRPC } from 'kitcn/server';
  const crpc = initCRPC.create();
  export const router = crpc.router;
  export const query = crpc.query;
  export const mutation = crpc.mutation;
  export const action = crpc.action;
  export const httpAction = crpc.httpAction;
  export const middleware = crpc.middleware;
  export default crpc;
  ```
- `convex/routers/articles.ts:4` — `export async function extractArticle(url, monidApiKey?)`.
  A plain function, not a Convex function, not called by anything. ~120 lines that
  duplicate `src/server.ts:229` but **lack** the direct-HTML fallback the server copy has.
- `src/server.ts:229` — the live `POST /api/extract` handler. This is the behaviour of
  record; port from here, not from the Convex copy.
- `src/App.tsx` — calls `/api/extract` and `/api/tts` with plain `fetch`. No Convex
  client, no `QueryClientProvider`.
- `src/main.tsx` — 10 lines, bare `createRoot(...).render(<App />)`.
- `.env.local` — already defines `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL` and
  `VITE_CONVEX_SITE_URL`. The deployment exists; you do not need to create one.

Constraints from `convex/_generated/ai/guidelines.md` (read it before writing any Convex
code — `CLAUDE.md` requires this):

- `fetch()` works in the default Convex runtime; you do **not** need `"use node"` just
  to use it. Only add `"use node"` for Node built-ins, and never in a file that also
  exports queries or mutations.
- Never use `ctx.db` inside an action. Actions reach the database via `ctx.runMutation`.
- Every Convex value is capped at **1MB**. An extracted article's `content` must stay
  under that; reject or truncate rather than letting a mutation throw.
- Arrays may hold at most 8192 elements.

kitcn conventions, from https://kitcn.dev/docs:

- Procedures are built by chaining off the cRPC builders and validated with `zod`
  (already a dependency): `export const list = query.input(z.object({...})).query(async ({ ctx, input }) => {...})`.
- The client calls them through TanStack Query:
  `useQuery(crpc.articles.extract.queryOptions({ url }))`.
- `kitcn codegen` regenerates `convex/generated/*` and `convex/shared/api.ts`.

**Uncertainty flagged honestly**: the exact registration convention that makes
`kitcn codegen` discover a router (file naming, a root router export, or a config entry)
is not documented in the page excerpt available when this plan was written. Resolve it
from the kitcn docs and the existing generated files before writing procedures — that
is Step 1, and it is a STOP condition if you cannot.

## Commands you will need

| Purpose    | Command                        | Expected on success   |
|------------|--------------------------------|-----------------------|
| Install    | `bun install`                  | exit 0                |
| Typecheck  | `bun run typecheck`            | exit 0, no output     |
| Tests      | `bun test`                     | all pass (21 today)   |
| Build      | `bun run build`                | exit 0                |
| Convex dev | `bunx convex dev --once`       | deploys functions     |
| kitcn gen  | `bunx kitcn codegen`           | regenerates generated/|

## Scope

**In scope**:
- `convex/routers/articles.ts` (rewrite as cRPC procedures)
- `convex/` new files as needed (e.g. a root router, `convex/http.ts`)
- `src/main.tsx` (add providers)
- `src/App.tsx` (switch the extract call)
- `src/components/UrlInputModal.tsx` (switch its extract call — line ~63)
- `src/components/ClipboardDetectSheet.tsx` (switch its extract call — line ~34)
- `src/server.ts` (remove the `/api/extract` route **only** — see Step 6)
- `src/server.test.ts` (update the extract test)
- new Convex tests

**Out of scope**:
- `/api/tts` — plan 007. Leave the route and its rate limiting exactly as they are.
- `/api/auth/*` — plan 008. Do not touch the auth routes, `authCodes`, or `src/App.tsx`'s
  auth `useEffect`.
- `/r/:id` and `/api/og` — plan 009. These stay on the Worker; they are markup routes
  tied to the apex domain.
- `convex/routers/users.ts` — its authorization defects are plan 008's subject. Do not
  "fix it while you're in there"; a half-migrated auth surface is worse than none.
- `wrangler.jsonc` — no binding changes are needed for this plan.
- Convex hosting or custom domains. The Worker keeps `kinreader.com`.

## Git workflow

- Branch: `advisor/006-wire-kitcn-extract`
- Conventional Commits, one per step group.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Establish how kitcn discovers routers

Read the kitcn docs and `convex/generated/server.ts` (which calls
`registerProcedureNameLookup(procedureNames, "convex")`). Determine the registration
convention, then write the smallest possible probe: one trivial `query` procedure in
`convex/routers/articles.ts` built from `convex/crpc.ts`, and run codegen.

**Verify**: `bunx kitcn codegen` exits 0, then
`grep -c "extract\|ping" convex/generated/procedure-names.gen.ts` → at least `1`, and
`convex/shared/api.ts` no longer exports an empty `api`.

If `procedureNames` is still `{}` after codegen, STOP and report what you tried. Every
later step depends on this working.

### Step 2: Port the extraction logic into a Convex action

Rewrite `convex/routers/articles.ts` as cRPC procedures. Port the handler body from
`src/server.ts:229-455` — the **server** copy, which has the direct-HTML fallback and
the cleaning pipeline. The existing Convex `extractArticle` is the older, weaker copy;
replace it rather than extending it.

The action must:
- take `{ url: string }`, validated with `zod`;
- read `MONID_API_KEY` from the Convex environment (`process.env` inside a Convex
  function reads deployment env vars — set it with `bunx convex env set`), not from a
  client-supplied argument;
- return the same shape the current endpoint returns, so the client change in Step 5 is
  mechanical;
- guard the 1MB value limit: if `cleanContent` exceeds ~900,000 characters, truncate and
  set a flag on the response rather than letting the value limit throw.

Do **not** persist to the database yet. Saving extracted articles is user-scoped, which
needs the identity work in plan 008.

**Verify**: `bun run typecheck` → exit 0. `bunx convex dev --once` → deploys without error.

### Step 3: Set the Monid key in the Convex environment

```bash
bunx convex env set MONID_API_KEY <value>
```

Take the value from wherever the Worker gets it today. **Never print the value** and
never commit it.

**Verify**: `bunx convex env list` → includes `MONID_API_KEY`. Do not paste the output
into your report; report only that the key is present.

### Step 4: Add the client providers

In `src/main.tsx`, wrap the app in `ConvexProvider` (from `convex/react`, using
`import.meta.env.VITE_CONVEX_URL`) and `QueryClientProvider` (from
`@tanstack/react-query`, already a dependency). Follow kitcn's documented React setup —
if kitcn exports its own provider from `kitcn/react`, prefer that over hand-wiring.

**Verify**: `bun run build` → exit 0, and `bun run typecheck` → exit 0.

### Step 5: Switch the extract call

In `src/App.tsx`, replace the `fetch('/api/extract', ...)` call with the kitcn/Convex
call. Keep the surrounding loading and error handling behaviour identical — the user
should see no change.

`/api/extract` has **three** callers, not one. Migrate all three or the route removal
in Step 6 breaks the primary "paste a URL" flow:

- `src/App.tsx` — the library drawer's quick-extract
- `src/components/UrlInputModal.tsx:63` — the main URL input modal
- `src/components/ClipboardDetectSheet.tsx:34` — the clipboard-paste sheet

Each uses the same `useCRPC()` / `useMutation` pattern. Both modal components need test
coverage, because neither has any today — which is why a broken migration here would not
show up in `bun test`.

**Verify**: `bun test` → all pass. `grep -rc "api/extract" src/ --include=*.tsx` → `0`
across every file (the only permitted match is the 404 assertion in `src/server.test.ts`).

### Step 6: Remove the Spiceflow extract route

Delete the `.post('/api/extract', ...)` route from `src/server.ts` and update the
extract test in `src/server.test.ts` (the "missing url returns 400" case now belongs to
the Convex procedure, so move it to a Convex test rather than deleting the coverage).

Leave the rest of `src/server.ts` untouched.

**Verify**: `grep -c "'/api/extract'" src/server.ts` → `0`. `bun test` → all pass.
`bun run typecheck` → exit 0.

## Test plan

- A Convex test for the extract action using `convex-test`: a URL that yields content
  returns the expected shape; a malformed URL returns a handled error, not a throw; an
  oversized body is truncated rather than exceeding the 1MB limit. Stub `fetch` — the
  test suite must make no live network calls (the existing `src/server.test.ts` runs in
  ~200ms with zero network, keep that property).
- Update `src/server.test.ts` to drop the removed route's test and confirm the route is
  gone (a request to `/api/extract` no longer returns 400 — it should now 404).
- Keep all 21 existing tests passing.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0, all tests pass, extraction coverage still exists
- [ ] `grep -c "procedureNames = {}" convex/generated/procedure-names.gen.ts` returns `0`
- [ ] `grep -c "'/api/extract'" src/server.ts` returns `0`
- [ ] `grep -c "api/extract" src/App.tsx` returns `0`
- [ ] `bun run build` exits 0
- [ ] `bunx convex dev --once` deploys without error
- [ ] No file outside the in-scope list is modified

## STOP conditions

Stop and report if:

- `kitcn codegen` still produces an empty `procedureNames` after Step 1. This is the
  linchpin; do not work around it by calling Convex functions directly and skipping
  kitcn, and do not hand-edit any file marked "auto-generated by kitcn".
- The kitcn version installed (`kitcn@^0.32.1`) does not match the documented API. Report
  the mismatch rather than guessing at an older or newer syntax.
- Porting the extractor requires `"use node"`. It should not — `fetch` works in the
  default runtime. If you believe it does, say why.
- You find that removing `/api/extract` from `src/server.ts` breaks the TTS or auth
  routes. They are independent; report what you saw.
- `bunx convex dev --once` prompts for interactive input or fails to authenticate.

## Maintenance notes

- After this lands, extraction has exactly one implementation. The duplicate-logic
  finding in `plans/README.md` is resolved by deletion, not by refactoring.
- Article **persistence** is deliberately deferred to plan 008, because it is user-scoped
  and the identity story has to land first. Resist adding a `create` mutation here.
- A reviewer should check that the Worker still serves the SPA and that `/api/tts`,
  `/api/auth/*`, `/r/:id` and `/api/og` are untouched.
- The `articles` table and its `by_url` index already exist in `convex/schema.ts:19` and
  stay unused until 008.
