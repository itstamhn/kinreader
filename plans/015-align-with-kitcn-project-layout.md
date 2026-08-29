# Plan 015: Align the backend with kitcn's expected project layout

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat ffd136e..HEAD -- packages/backend apps/web/src/lib`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (every import path under `packages/backend` moves)
- **Depends on**: `plans/013` (the workspace split)
- **Blocks**: `plans/008` — see "Why this comes first"
- **Category**: tech-debt / conventions
- **Planned at**: commit `ffd136e`, 2026-08-29

## Why this matters

kitcn ships its own agent skill inside the npm package, now vendored at
`.claude/skills/kitcn`. Its `references/setup/index.md` documents the layout every kitcn
instruction, template and generator assumes:

```text
convex.json            { "functions": "convex/functions", "codegen": { staticApi, staticDataModel } }
convex/functions/      deployed Convex functions
convex/lib/            backend helpers, NOT deployed as API
convex/shared/         shared types/meta imported by the client
```

This repo has no `convex.json`, so the functions root is the Convex default — `convex/`
itself. That single missing file is the whole divergence, and it has three consequences:

1. **Everything under `convex/` is deployed.** `convex/lib/rateLimiter.ts`,
   `convex/shared/api.ts` and `convex/generated/` all sit inside the deploy root. kitcn's
   split exists precisely so `lib` and `shared` stay out of it. Nothing is broken today —
   they are plain modules — but the boundary kitcn draws is not being drawn.
2. **Static codegen is off.** `codegen.staticApi` / `staticDataModel` are unset.
3. **Every path in kitcn's own documentation is wrong for this repo.** The skill says
   server wiring imports come from `convex/functions/generated/`; here it is
   `convex/generated/`. An agent following the skill will write files into a tree that
   does not exist, or "fix" the paths in the wrong direction.

Point 3 is the expensive one, and it is why this is worth doing rather than noting.

## Why this comes first (before plan 008)

Plan 008 creates `convex/auth.ts` and `convex/auth.config.ts` and wires Better Auth, and
it explicitly says to follow the current kitcn docs rather than write them from memory.
Those docs place auth wiring inside the `convex/functions/` tree and import it from
`convex/functions/generated/auth`. Executing 008 against the current layout means writing
auth wiring at paths the docs do not describe, and then moving all of it in this plan
afterwards — auth wiring done twice, the second time under a migration.

Do this first. It is mechanical; 008 is not.

## Current state

```text
packages/backend/convex/
├── crpc.ts                      # initCRPC re-exports
├── schema.ts
├── routers/                     # the procedures: articles, tts, ttsInternal, users
├── lib/rateLimiter.ts
├── shared/api.ts                # the type-complete API surface, imported by apps/web
├── generated/                   # server.ts, auth.ts, migrations.gen.ts, routers/*.runtime.ts
└── _generated/                  # Convex's own codegen
```

- No `convex.json` anywhere in the repo.
- `apps/web` imports the API as `@kinreader/backend/api`, which resolves through the
  package `exports` map to `./convex/shared/api.ts` (plan 013).
- `bunx kitcn codegen` runs cleanly from `packages/backend` and regenerates in place —
  verified at commit `ffd136e`. The layout is *workable*; it is just not kitcn's.

## Scope

**In scope**: `convex.json`, moving the function modules under `convex/functions/`, the
import paths that follow, the `@kinreader/backend` exports map, and the docs that name
these paths (`CLAUDE.md`, `AGENTS.md`, `README.md`).

**Out of scope**:

- Auth (plan 008). This plan moves files; it does not add behaviour.
- The `@convex/*` tsconfig alias kitcn's docs use. That alias is for single-app repos
  where `convex/` sits beside `src/`. Here the backend is a workspace package and
  `@kinreader/backend/api` already does that job — adopting both would give the same
  module two names. **Deliberately declined**; record it if a future kitcn version starts
  requiring the alias.
- Any procedure logic. If a file's contents change beyond its imports, that is a
  different plan.

## Steps

### Step 1: Add `convex.json`

**Create:** `packages/backend/convex.json` — note this sits beside `convex/`, not inside.

```json
{
  "functions": "convex/functions",
  "codegen": {
    "staticApi": true,
    "staticDataModel": true
  }
}
```

**Verify**: nothing yet — the directory it names does not exist until Step 2. Do not run
codegen between these two steps; it will fail, and that failure is not informative.

### Step 2: Move the deployed modules

```bash
cd packages/backend
mkdir -p convex/functions
git mv convex/schema.ts convex/crpc.ts convex/routers convex/generated convex/_generated convex/functions/
```

`lib/` and `shared/` **stay where they are**, at `convex/lib` and `convex/shared`. That is
the entire point: they are now outside the functions root and no longer deploy.

**Verify**: `git status` shows renames. `ls convex` → `functions`, `lib`, `shared`.

### Step 3: Repair the import paths

The moved files reach `lib/` and `shared/` by relative path, and those paths just got one
level deeper. Expect edits in the routers (`../lib/rateLimiter` → `../../lib/rateLimiter`)
and in `shared/api.ts`, which points at `../routers/*` and must now point at
`../functions/routers/*`.

Let `tsc` enumerate them rather than guessing:

```bash
bun run typecheck 2>&1 | grep "Cannot find module"
```

**Verify**: `bun run typecheck` exits 0 for `@kinreader/backend`.

### Step 4: Update the package exports map

`packages/backend/package.json` — `./api` and `./dataModel` both move:

```json
"exports": {
  "./api": "./convex/shared/api.ts",
  "./dataModel": "./convex/functions/_generated/dataModel.d.ts"
}
```

`./api` is unchanged (`shared/` did not move) — which is the payoff: **`apps/web` needs no
edit at all.** If you find yourself changing an import in `apps/web`, something moved that
should not have.

**Verify**: `grep -rn "@kinreader/backend" apps/` shows the same imports as before this
plan. `bun run typecheck` exits 0 for all three packages.

### Step 5: Regenerate and diff

```bash
cd packages/backend && bunx kitcn codegen
```

Static codegen is now on, so expect `_generated/api.d.ts` and `_generated/dataModel.d.ts`
to gain real static types where they were dynamic. That is the point of Step 1's
`codegen` block.

Read the diff. Generated files changing shape is expected; **generated files changing
*content* — a procedure name, a table, an argument type — is not**, and means something
moved that should not have.

**Verify**: `bun run typecheck` exits 0; `bun run test` passes with the same counts as
before (23 backend, 49 web, 23 marketing).

### Step 6: Update the docs that name these paths

`CLAUDE.md` and `AGENTS.md` both point at
`packages/backend/convex/_generated/ai/guidelines.md`, which is now under
`convex/functions/_generated/`. `CLAUDE.md`'s repo-layout table and `README.md`'s project
tree both need the new shape.

Add one line to `CLAUDE.md`'s backend row: **the functions root is `convex/functions`, and
`convex/lib` and `convex/shared` are deliberately outside it.** That sentence is what stops
the next agent from "helpfully" moving them back.

**Verify**: `grep -rn "convex/_generated/ai" CLAUDE.md AGENTS.md` returns nothing.

## Test plan

There is nothing new to test — the suite is the test. Same counts before and after, in
every package. A drop means a file stopped being discovered, which is the characteristic
silent failure of a move like this.

The one genuinely new assertion worth adding: a test that `convex/lib` and `convex/shared`
are **not** inside the functions root, so the boundary this plan draws cannot be quietly
erased by a later move. Read `convex.json`, resolve `functions`, and assert neither
directory is under it.

## Done criteria

- [ ] `packages/backend/convex.json` exists with `functions` and the `codegen` block
- [ ] `convex/functions/` holds schema, crpc, routers, generated, _generated
- [ ] `convex/lib` and `convex/shared` are outside the functions root, with a test saying so
- [ ] `bunx kitcn codegen` runs clean and its diff is structural, not semantic
- [ ] `bun run typecheck` exits 0 across all three packages
- [ ] `bun run test` passes with unchanged counts
- [ ] `grep -rn "@kinreader/backend" apps/` is unchanged from before the plan
- [ ] `CLAUDE.md`, `AGENTS.md`, `README.md` name the new paths

## STOP conditions

- `bunx kitcn codegen` wants to write outside `convex/functions/` after `convex.json`
  exists. That means the config is not being read; do not paper over it by moving files to
  wherever codegen happens to point.
- A generated file's *content* changes — a procedure name, a table, an argument type.
  Structural change is expected from `staticApi`; semantic change means a module moved
  that should not have.
- `apps/web` needs an import edit. `shared/` does not move in this plan; if the web app
  breaks, the cause is in Step 2, not in `apps/web`.
- Turning on `staticApi` breaks the convex-test module maps in `routers/*.test.ts`. Those
  maps are path-sensitive (see plan 013's notes) and are the most likely casualty.

## Maintenance notes

- The vendored skill at `.claude/skills/kitcn` is a **copy**, pinned to kitcn 0.32.1 by
  hand. It does not update with the package and is not in `skills-lock.json`, because
  kitcn ships it inside its npm package rather than through the `agent-skills` installer.
  `.claude/skills/kitcn/VENDORED.md` has the refresh command. Re-read
  `references/setup/index.md` after any kitcn bump — that file is what this plan tracks.
- kitcn is monorepo-aware in ways worth knowing before the mobile app: `kitcn init` takes
  `--cwd apps --name <app>`, and `references/setup/expo.md` documents an
  `init -t expo` path. Whoever writes the mobile plan should read that file first rather
  than hand-rolling an Expo app beside a kitcn backend.
