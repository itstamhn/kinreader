# Plan 013: Split the repo into a Bun workspace — `apps/web` + `packages/backend`

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat fff13f2..HEAD -- package.json bunfig.toml tsconfig.json vite.config.ts wrangler.jsonc`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (nothing changes behaviourally; everything changes location)
- **Depends on**: —
- **Category**: tech-debt / dx
- **Planned at**: commit `fff13f2`, 2026-08-29

## Why this matters

Two more clients are coming: an Astro marketing site (landing + blog) and an Expo mobile
app. Both need the same backend and neither can live in `src/`.

The move is worth doing **now**, while there is exactly one app, because it is purely
mechanical today and stops being mechanical the moment a second app has opinions about
shared config. Doing it first also forces the question that actually matters for mobile —
*what is the API?* — to be answered by the directory structure rather than by whichever
import someone reaches for.

The answer this plan encodes: **Convex is the API for every client.** `packages/backend`
is the shared contract. Anything left in the Worker (`src/server.ts`, `src/worker.ts`) is
web-only by definition, which is the correct status for the two markup routes and the
wrong status for auth — see "What this sets up" below.

This plan changes **no behaviour**. Same bundle, same routes, same tests. If anything
about the running app differs afterwards, something went wrong.

## Current state

Everything is at the repo root, in one package:

- `package.json` — one manifest; app deps (react, kitcn, lucide, @tanstack/react-query)
  and backend deps (convex) and Worker deps (spiceflow, zod) are indistinguishable.
- `src/` — the Vite SPA **and** `server.ts` (Spiceflow) **and** `worker.ts` (Cloudflare
  entry). `index.html`, `public/`, `vite.config.ts`, `wrangler.jsonc` at root.
- `convex/` — Convex functions, `_generated/`, the kitcn cRPC layer, and
  `shared/api.ts`, which is already the type-complete API surface both future clients
  want.
- `bunfig.toml` — `preload = ["./src/test-setup.ts"]`, applied to every `bun test`
  in the repo, including the Convex tests that have no use for happy-dom.
- `.env.test` at the root, loaded because tests run from the root.
- `src/lib/convex.tsx:11` — `import { api } from '../../convex/shared/api'`. This
  relative reach across what will become a package boundary is the single import that
  makes the split visible.

## Scope

**In scope**: file moves (`git mv`), workspace manifests, per-package `tsconfig`/`bunfig`,
the one cross-package import, CI, and the doc paths in `CLAUDE.md` / `AGENTS.md`.

**Out of scope** — do not do any of these here, each is its own plan:

- Adding Astro or Expo. This plan only makes room for them.
- Moving auth to Convex (plan 008), or retiring Spiceflow (plan 009).
- Extracting a `packages/core` of shared logic. There is no second consumer yet; an
  abstraction with one caller is shaped like that caller and will be wrong for the next
  one. Extract it in the mobile plan, from real duplication.
- Any dependency upgrade. A version bump hidden inside a 200-file move is undebuggable.

## Target layout

```
kinreader/
├── apps/
│   └── web/                  # the Vite SPA + the Cloudflare Worker, unchanged
│       ├── index.html
│       ├── public/
│       ├── src/
│       ├── vite.config.ts
│       ├── wrangler.jsonc
│       ├── bunfig.toml
│       ├── .env.test
│       ├── tsconfig.json
│       └── package.json      # @kinreader/web
├── packages/
│   └── backend/              # the shared API for every client
│       ├── convex/
│       ├── tsconfig.json
│       └── package.json      # @kinreader/backend
├── plans/
├── package.json              # workspace root, private, no app deps
├── tsconfig.base.json
└── bun.lock
```

`apps/marketing` (Astro) and `apps/mobile` (Expo) slot in beside `apps/web` later. No
`packages/ui` — see "Maintenance notes".

## Steps

### Step 1: Create the workspace root

Rewrite the root `package.json` as a manifest only — no dependencies of its own:

```json
{
  "name": "kinreader",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "bun run --filter '@kinreader/web' dev",
    "typecheck": "bun run --filter '*' typecheck",
    "test": "bun run --filter '*' test",
    "build": "bun run --filter '*' build"
  }
}
```

Bun has workspace filtering built in (`bun run --filter`, verified on 1.3.11) — that is
the whole task runner this repo needs. Do **not** add Turborepo, Nx, Bazel or Pants; see
"Maintenance notes" for the trigger that would change that.

Delete the root `index.ts` (`console.log("Hello via Bun!")` — the `bun init` leftover; it
is the `module` entry of the current manifest and nothing imports it).

**Verify**: nothing yet — the workspace is empty until Step 2.

### Step 2: Move the files with `git mv`

Use `git mv` for every move, one command per path, so history follows the files and the
diff reads as renames rather than delete-plus-add.

```bash
mkdir -p apps/web packages/backend
git mv src apps/web/src
git mv public apps/web/public
git mv index.html vite.config.ts wrangler.jsonc bunfig.toml .env.test apps/web/
git mv convex packages/backend/convex
```

`convex/` moves **wholesale**, which is what makes it safe: the convex-test module map in
`convex/routers/*.test.ts` uses paths relative to the test file, and `shared/api.ts`
imports `../routers/...`. Nothing inside the directory needs editing.

**Verify**: `git status` shows renames (`R`), not additions. `ls apps/web packages/backend`.

### Step 3: Write the two package manifests

`packages/backend/package.json` — `@kinreader/backend`, private, and the export that
replaces the relative reach:

```json
{
  "name": "@kinreader/backend",
  "private": true,
  "type": "module",
  "exports": {
    "./api": "./convex/shared/api.ts",
    "./dataModel": "./convex/_generated/dataModel.d.ts"
  },
  "scripts": {
    "dev": "convex dev",
    "deploy": "convex deploy",
    "codegen": "kitcn codegen",
    "typecheck": "tsc --noEmit -p convex/tsconfig.json",
    "test": "bun test convex/"
  },
  "dependencies": { "convex": "1.44.0", "kitcn": "^0.32.1", "zod": "^4.4.3" },
  "devDependencies": { "convex-test": "^0.0.56" }
}
```

`apps/web/package.json` — `@kinreader/web`, carrying the app and Worker deps
(react, react-dom, @tanstack/react-query, lucide-react, kitcn, spiceflow, zod) and
`"@kinreader/backend": "workspace:*"`. Move the existing `dev`/`build`/`start`/
`typecheck`/`test` scripts here verbatim; `dev` keeps the `concurrently` pair.

`zod` and `kitcn` are genuine dependencies of **both** packages (`kitcn/react` in the app,
`kitcn/server` in the backend; zod in `src/server.ts` and in both Convex routers). List
them in both — that is what a workspace is for, not a reason to hoist.

**Verify**: `bun install` at the root → one `bun.lock`, `node_modules/@kinreader/backend`
symlinked. `bun pm ls` shows both workspace packages.

### Step 4: Fix the one cross-package import

`apps/web/src/lib/convex.tsx`:

```diff
-import { api } from '../../convex/shared/api';
+import { api } from '@kinreader/backend/api';
```

This is the only import that crosses the new boundary. If `grep -rn "\.\./\.\./convex"
apps/` returns anything else after this step, that is a second boundary crossing the plan
did not anticipate — report it rather than adding another `exports` entry on instinct.

**Verify**: `grep -rn "\.\./\.\./convex" apps/` returns nothing.

### Step 5: Split the TypeScript config

Root `tsconfig.base.json` gets the shared compiler options from today's root
`tsconfig.json` (strict, target/lib, `noUncheckedIndexedAccess`, etc.).

`apps/web/tsconfig.json` extends it and keeps the DOM-flavoured bits: `"lib": ["DOM",
"DOM.Iterable", "ESNext"]`, `"jsx": "react-jsx"`, `"types": ["bun"]`.

`packages/backend` already has `convex/tsconfig.json`, written by Convex — leave it alone
and point the package's `typecheck` script at it, as in Step 3.

**Verify**: `bun run typecheck` from the root → exit 0, and the output shows **both**
packages being checked, not one.

### Step 6: Per-package test setup

The root `bunfig.toml` currently preloads happy-dom for every test in the repo. Moved into
`apps/web/`, its `preload = ["./src/test-setup.ts"]` path resolves correctly again and it
stops applying to the Convex tests, which never wanted a DOM.

`.env.test` moves with it (Step 2) — it exists because `src/lib/convex.tsx` constructs a
`ConvexReactClient` at module scope, so it must sit beside the app whose tests need it.

Note for whoever runs the suite: `bun test` **at the root** no longer picks up
`apps/web/bunfig.toml`, so run tests through `bun run test` (which fans out via
`--filter`) or from inside the package. A bare root `bun test` will fail the App tests
with happy-dom missing — expected, not a regression.

**Verify**: `bun run test` from the root → 79 pass, 0 fail, same count as before the
split. `cd packages/backend && bun test` → the Convex tests pass with no happy-dom preload.

### Step 7: CI and the deploy path

`.github/workflows/ci.yml` keeps its three gates — the steps already call `bun run
typecheck` / `bun test` / `bun run build`, which now fan out. Change `bun test` to
`bun run test` so it goes through the filter (see Step 6).

Deploys run from the app that owns the config:

```bash
cd apps/web && bunx wrangler deploy          # web + Worker
cd packages/backend && bunx convex deploy    # backend
```

`wrangler.jsonc`'s `main` (`src/worker.ts`) and `assets.directory` (`./dist`) are already
relative to the config file, so they need no edit once the file lives in `apps/web`.

**Verify**: `cd apps/web && bun run build` → `apps/web/dist/` with `index.html`,
`_headers`, and the hashed assets. `bunx wrangler deploy --dry-run` → exit 0.

### Step 8: Update the paths in the agent docs

`CLAUDE.md` and `AGENTS.md` both tell agents to read `convex/_generated/ai/guidelines.md`.
That path is now `packages/backend/convex/_generated/ai/guidelines.md`. Update both, and
add a short "Repo layout" section to `CLAUDE.md` naming the workspaces and which commands
run from where — an agent that guesses wrong here wastes a whole session.

`README.md`'s "Project Structure" tree is now wrong in every line; update it, and correct
the Quick Start path (it still hardcodes `/Users/tambot/Projects/kinetic-reader`).

**Verify**: `grep -rn "convex/_generated/ai" CLAUDE.md AGENTS.md` shows the new path.

## Test plan

The whole point is that the test suite is untouched. There is nothing new to test — the
suite **is** the test of this plan.

- Same test count before and after: 79 pass, 0 fail. A drop means a file stopped being
  discovered, which is the characteristic failure of a move like this and is silent.
- `apps/web/src/server.test.ts`'s glob test (`no file under src/ references api/extract or
  api/tts`) scans `import.meta.dir`, so it follows the move — confirm it still reports
  zero offenders rather than zero *files scanned*.
- Convex tests must pass **without** the happy-dom preload; if any of them depended on it
  silently, this is where it surfaces.

## Done criteria

- [ ] `git status` recorded the moves as renames, not delete-plus-add
- [ ] `bun install` produces a single root `bun.lock` and links both workspace packages
- [ ] `bun run typecheck` exits 0 and covers both packages
- [ ] `bun run test` → 79 pass, 0 fail
- [ ] `cd apps/web && bun run build` exits 0 and emits `dist/_headers`
- [ ] `cd apps/web && bunx wrangler deploy --dry-run` exits 0
- [ ] `grep -rn "\.\./\.\./convex" apps/` returns nothing
- [ ] `CLAUDE.md`, `AGENTS.md` and `README.md` describe the new layout
- [ ] `git diff --stat main` shows no change to any file's *contents* except the manifests,
      tsconfigs, `src/lib/convex.tsx`, CI, and the docs

## STOP conditions

- The test count drops, or any test that passed before fails after. Do not "fix" a moved
  test by editing its assertions — find the path that stopped resolving.
- `bunx convex dev` cannot find its deployment from `packages/backend`. This is an
  environment-variable problem, not a layout problem: `CONVEX_DEPLOYMENT` lives in a
  `.env.local` that must now sit in `packages/backend`, while the app needs
  `VITE_CONVEX_URL` / `VITE_CONVEX_SITE_URL` in `apps/web/.env.local`. One root
  `.env.local` served both before. Report before inventing a symlink.
- `bunx kitcn codegen` rewrites `convex/shared/api.ts` differently after the move. It
  should be byte-identical; if it is not, stop — the generated API surface is the contract
  both future clients depend on.
- The Worker deploy dry-run fails on an asset path. Do not start editing `wrangler.jsonc`
  paths speculatively.

## What this sets up (not in scope here)

The ordering matters more than the layout:

1. **Plan 008 (auth → Convex) becomes the mobile blocker.** The Google OAuth flow fixed in
   `fff13f2` is web-only by construction: a 302 dance, an HttpOnly `SameSite=Lax` cookie,
   and a token read out of the URL on mount. React Native has no address bar to read it
   from. Once auth is a Convex concern, the mobile app gets sessions and Google sign-in via
   `expo-auth-session` + a deep link, and both clients share one identity. Until then,
   hold the line on Worker auth rather than growing it.
2. **Astro (`apps/marketing`) should absorb `/r/:id` and `/api/og`.** Plan 009 keeps those
   two in the Worker because they are tied to `kinreader.com` — but they are a share page
   and an OG card, hand-built as escaped HTML strings (which is what plan 004 had to go fix
   once already). They are a static-site generator's job. Doing that deletes
   `src/server.ts` entirely and makes 009 smaller, so **009 should be re-planned after the
   Astro app exists**, not executed as written.
3. **`packages/core` comes with mobile, not before it.** The shareable surface is thinner
   than it looks: `types.ts`, and the pure "which word is active at time *t*" math.
   `SpeechEngine` builds an `HTMLAudioElement` and grabs `window.speechSynthesis` in its
   constructor; `storage.ts` is `localStorage`. Those need platform adapters behind a
   shared interface, written against two real callers.

Still undecided, and needed before the Astro plan: **the domain split.** Either Astro on
the apex with the app at `app.kinreader.com` (best for SEO, independent deploys, but the
app changes URL and installed PWAs break), or one origin path-split at the edge (keeps the
PWA and a single cookie domain, costs edge routing config). This plan is deliberately
agnostic to that choice.

## Maintenance notes

- **No Turborepo, Nx, Bazel or Pants.** They solve a problem this repo does not have:
  `bun run build` finishes in ~340ms, Convex deploys itself, and there are no
  cross-package build outputs to cache. Bazel and Pants are hermetic polyglot build
  systems whose cost is a BUILD file per target and giving up the native dev servers of
  Vite, Astro and Expo. Nx pays off at tens of packages and multiple teams. Turborepo is
  the cheapest of the four and still buys nothing while the task graph is "build one app".
  The trigger to revisit: CI wall-clock past ~5 minutes, **or** a package whose build
  output another package consumes, **or** more than one person waiting on the same CI.
  Until then, `bun run --filter` and GitHub Actions `paths:` filters cover it.
- **Do not create `packages/ui`.** Web is Tailwind-on-DOM; React Native has no DOM and no
  Tailwind. A component package shared between them is the standard way these repos rot.
  Share types and pure functions; let each app own its rendering.
- **Verify Bun + Expo early.** Metro has historically been happiest with npm/pnpm, and
  workspace symlinks are exactly what it has trouble resolving. Before the mobile plan
  commits to this layout, stand up a throwaway Expo app inside `apps/` and check that
  Metro resolves `@kinreader/backend` through the symlink. If it cannot, that is worth
  knowing while the only cost is deleting a scratch directory.
- The web app keeps both `spiceflow` and its Worker after this split. That is temporary by
  design — plans 008 and 009 remove it — but nothing here depends on that happening.
