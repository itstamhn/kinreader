# Plan 002: Establish a working verification baseline — `typecheck` and `test` scripts that pass

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2477929..HEAD -- package.json tsconfig.json src/App.tsx src/server.ts src/utils/speechEngine.ts`
> If any of those changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/001-fix-pause-import-crash.md`
- **Category**: tests / dx
- **Planned at**: commit `2477929`, 2026-08-28

## Why this matters

This repo has no `typecheck`, `test`, or `lint` script and zero test files. `tsc` is
never run, so type errors accumulate silently — that is exactly how the
`Pause is not defined` crash (plan 001) reached production in a user-facing code path.

`bunx tsc --noEmit` currently reports 23 errors (24 before plan 001). Until that count
is zero and wired to a script, the compiler cannot act as a gate: a real error is
indistinguishable from the existing noise.

Plans 003, 004 and 005 change authentication, HTML escaping and request handling in
`src/server.ts`. Those are exactly the changes you want a green typecheck and a test
suite standing behind. This plan must land before them.

## Current state

- `package.json` — scripts block has `dev`, `dev:api`, `dev:web`, `build`, `start`. No
  `typecheck`, no `test`, no `lint`. TypeScript is a `peerDependencies` entry (`^5`),
  not a devDependency.
- `tsconfig.json` — `strict: true`, `noUncheckedIndexedAccess: true`, `noEmit: true`,
  `types: ["bun"]`. There is no `include`/`exclude`, so `tsc` walks the whole repo.
- `CLAUDE.md` states the project standard: use `bun test`, not jest or vitest; use
  `bun install`, not npm/pnpm; use `bunx`, not `npx`.

Current `scripts` block:

```json
// package.json
  "scripts": {
    "dev": "concurrently -n \"api,web\" -c \"magenta,cyan\" \"bun --watch src/server.ts\" \"vite\"",
    "dev:api": "bun --watch src/server.ts",
    "dev:web": "vite",
    "build": "vite build",
    "start": "bun src/server.ts"
  },
```

The 23 errors, verbatim from `bunx tsc --noEmit` at commit `2477929` (after plan 001):

```
src/App.tsx(328,11): error TS2322: Type 'string | undefined' is not assignable to type 'string'.
src/server.ts(19,21): error TS18046: 'body' is of type 'unknown'.
src/server.ts(29,51): error TS18046: 'body' is of type 'unknown'.
src/server.ts(74,21): error TS18046: 'body' is of type 'unknown'.
src/server.ts(75,20): error TS18046: 'body' is of type 'unknown'.
src/server.ts(76,21): error TS18046: 'body' is of type 'unknown'.
src/server.ts(219,19): error TS18046: 'body' is of type 'unknown'.
src/server.ts(239,27): error TS18046: 'body' is of type 'unknown'.
src/server.ts(347,37): error TS2532: Object is possibly 'undefined'.
src/server.ts(348,43): error TS2532: Object is possibly 'undefined'.
src/server.ts(351,37): error TS2532: Object is possibly 'undefined'.
src/server.ts(354,39): error TS2532: Object is possibly 'undefined'.
src/server.ts(449,20): error TS18046: 'body' is of type 'unknown'.
src/server.ts(450,24): error TS18046: 'body' is of type 'unknown'.
src/server.ts(463,30): error TS18046: 'body' is of type 'unknown'.
src/server.ts(464,28): error TS18046: 'body' is of type 'unknown'.
src/server.ts(465,23): error TS18046: 'body' is of type 'unknown'.
src/server.ts(466,23): error TS18046: 'body' is of type 'unknown'.
src/server.ts(557,52): error TS2532: Object is possibly 'undefined'.
src/server.ts(588,24): error TS18046: 'body' is of type 'unknown'.
src/server.ts(589,25): error TS18046: 'body' is of type 'unknown'.
src/server.ts(643,50): error TS2532: Object is possibly 'undefined'.
src/utils/speechEngine.ts(160,40): error TS2532: Object is possibly 'undefined'.
```

They fall into exactly three classes:

1. **TS18046 `'body' is of type 'unknown'`** (14 errors) — `await request.json()`
   returns `unknown` under `strict`. Every route in `src/server.ts` then reads
   properties off it. Example, as it exists today:

   ```ts
   // src/server.ts:18-19
         const body = await request.json();
         const email = body.email?.trim().toLowerCase();
   ```

2. **TS2532 `Object is possibly 'undefined'`** (8 errors) — caused by
   `noUncheckedIndexedAccess: true`, which types every index access as `T | undefined`.
   Two shapes: regex capture groups (`src/server.ts` 347, 348, 351, 354) and
   last-element array access (`src/server.ts` 557, 643 and
   `src/utils/speechEngine.ts:160`). Example:

   ```ts
   // src/server.ts:557
             const totalDuration = words.length > 0 ? words[words.length - 1].end : 0;
   ```

3. **TS2322 in `src/App.tsx:328`** — `urlParams.get('email')` returns `string | null`,
   assigned into a `UserProfile.email: string` field.

## Commands you will need

| Purpose   | Command                | Expected on success        |
|-----------|------------------------|----------------------------|
| Install   | `bun install`          | exit 0                     |
| Typecheck | `bunx tsc --noEmit`    | exit 0, **no output**      |
| Tests     | `bun test`             | all pass                   |
| Build     | `bun run build`        | exit 0                     |

## Scope

**In scope**:
- `package.json` (add scripts + devDependencies)
- `bunfig.toml` (create)
- `src/server.ts` (type-only changes)
- `src/utils/speechEngine.ts` (type-only changes)
- `src/App.tsx` (one null-guard only — see Step 4)
- `src/lib/storage.test.ts` (create)
- `src/components/LibraryDrawer.test.tsx` (create)
- `src/server.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- `tsconfig.json` — **do not relax any compiler flag.** `strict` and
  `noUncheckedIndexedAccess` are deliberate. Turning one off to clear errors defeats
  the entire purpose of this plan.
- The **runtime behavior** of any endpoint. Every change in `src/server.ts` and
  `src/utils/speechEngine.ts` here is type-only: same inputs, same outputs, same status
  codes. Plans 003/004/005 change behavior; this one does not.
- The auth logic in `src/App.tsx:317-336` beyond the single null-guard in Step 4.
  Plan 003 rewrites that whole block; a larger change here will conflict with it.
- `convex/` — that directory has its own `tsconfig.json` and is not currently imported
  by `src/`. Leave it alone.
- Adding a linter. `lint` is deliberately not part of this plan; typecheck plus tests is
  the baseline. Adding ESLint/Biome config here would triple the diff.

## Git workflow

- Branch: `advisor/002-verification-baseline`
- Conventional Commits, as in `git log`. Suggested commits, one per step:
  `chore: add typecheck and test scripts`, `fix(types): type request bodies in server.ts`,
  `test: add first regression tests`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the scripts and test dependencies

In `package.json`, add to `scripts`:

```json
    "typecheck": "tsc --noEmit",
    "test": "bun test"
```

Then install the test harness. `bun test` has no DOM, so component tests need one:

```bash
bun add -d typescript happy-dom @happy-dom/global-registrator @testing-library/react @testing-library/dom
```

`typescript` is currently only a `peerDependencies` entry; adding it as a devDependency
makes `bun run typecheck` work on a clean clone.

**Verify**: `bun run typecheck 2>&1 | grep -c "error TS"` → `23` (script resolves and
runs; errors not fixed yet).

Count with `grep -c "error TS"`, **not** `wc -l` — TypeScript wraps the elaboration of
`src/App.tsx(328,11)` onto a second physical line, so `wc -l` reports 24.

### Step 2: Register the DOM for `bun test`

Create `bunfig.toml` at the repo root:

```toml
[test]
preload = ["./src/test-setup.ts"]
```

Create `src/test-setup.ts`:

```ts
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
```

**Verify**: `bun test 2>&1 | tail -3` → reports `0 pass, 0 fail` (harness loads, no
tests yet). It must not error on the preload.

### Step 3: Fix the 14 TS18046 `body` errors in `src/server.ts`

These are the four `await request.json()` call sites: lines 18, 73, 218, 448, plus the
ElevenLabs branch reading `body` at 588-589.

Declare request-body interfaces near the top of `src/server.ts`, directly below the
existing imports, and cast at each `request.json()` call site. **Type-only — do not add
runtime validation or change any response.**

Target shape:

```ts
interface MagicLinkBody { email?: string; autosendApiKey?: string }
interface VerifyBody { email?: string; code?: string; token?: string }
interface ExtractBody { url?: string; monidApiKey?: string }
interface TtsBody {
  text?: string;
  provider?: string;
  sonioxApiKey?: string;
  groqApiKey?: string;
  sonioxVoice?: string;
  speed?: number;
  apiKey?: string;
  voiceId?: string;
}
```

Then at each call site, e.g.:

```ts
// src/server.ts:18 — was: const body = await request.json();
      const body = (await request.json()) as MagicLinkBody;
```

Apply the matching interface at line 73 (`VerifyBody`), line 218 (`ExtractBody`) and
line 448 (`TtsBody`).

**Verify**: `bunx tsc --noEmit 2>&1 | grep -c TS18046` → `0`.

### Step 4: Fix the 9 TS2532 errors with guards, not assertions

Prefer real narrowing over `!`. Two patterns:

Regex captures (`src/server.ts` 347, 348, 351, 354) — the match is already checked for
truthiness, but the capture group is not. Bind the group to a local first:

```ts
      const ogTitle = ogTitleMatch?.[1];
      const pageTitle = titleTagMatch?.[1];
      if (ogTitle) title = ogTitle.trim();
      else if (pageTitle) title = pageTitle.trim();
```

Last-element access (`src/server.ts` 557 and 643, `src/utils/speechEngine.ts:160`) —
each is already guarded by a `.length > 0` check that TypeScript cannot connect to the
index. Bind the element:

```ts
      const lastWord = words[words.length - 1];
      const totalDuration = lastWord ? lastWord.end : 0;
```

`src/App.tsx:328` — `urlParams.get('email')` is `string | null`. The enclosing
`if (token && email)` on line 325 already guarantees it is non-null at 328; the
narrowing just doesn't survive into the object literal. Bind it above the `if`:

```ts
      const email = urlParams.get('email');
      // ...
      if (token && email) {
        const newUser: UserProfile = {
          email,   // now narrowed to string
```

Keep this change minimal — plan 003 rewrites this block entirely.

**Verify**: `bunx tsc --noEmit` → exit 0, **no output at all**.

### Step 5: Write the first three tests

Create `src/lib/storage.test.ts` — pure functions, no network:

```ts
import { test, expect, beforeEach } from 'bun:test';
import { saveArticleToLibrary, getSavedArticles, deleteArticleFromLibrary } from './storage';
```

Cover: saving an article returns it in `getSavedArticles()`; saving the same
`sourceUrl` twice updates rather than duplicates; delete removes it. Call
`localStorage.clear()` in `beforeEach`.

Create `src/components/LibraryDrawer.test.tsx` — **this is the regression test for plan
001**. Render `LibraryDrawer` with `isPlaying={true}` and an open drawer, and assert it
mounts without throwing. Before plan 001's fix this test throws
`ReferenceError: Pause is not defined`; after it, it passes.

Create `src/server.test.ts` — exercise the exported `app` directly, no live server:

```ts
import { app } from './server';

const res = await app.handle(new Request('http://localhost/api/health'));
```

Cover: `/api/health` returns 200 with `status: 'ok'`; `/api/tts` with an empty body
returns 400; `/api/extract` with no `url` returns 400. These three are cheap, need no
API keys, and give plans 003/004/005 something to build on.

**Verify**: `bun test` → all pass, at least 3 test files, 0 failures.

### Step 6: Confirm the gate is real

**Verify**: temporarily add `const x: number = "nope";` to `src/App.tsx`, run
`bun run typecheck` → it must **fail** with a TS2322 error. Then remove the line and
confirm `bun run typecheck` exits 0 again. This proves the gate catches what it is
supposed to catch. Do not commit the temporary line.

## Test plan

- `src/lib/storage.test.ts` — happy path (save → read back), the upsert-not-duplicate
  case, and delete. Pure localStorage, fast.
- `src/components/LibraryDrawer.test.tsx` — regression for plan 001: renders with
  `isPlaying={true}` without throwing. This is the specific case that crashed
  production.
- `src/server.test.ts` — `/api/health` 200, `/api/tts` empty-body 400, `/api/extract`
  missing-url 400.
- There is no existing test to model against — these are the first three. Keep them
  simple and dependency-free so plans 003/004/005 can extend the files.
- Verification: `bun test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0 with no output
- [ ] `bun test` exits 0; `src/lib/storage.test.ts`,
      `src/components/LibraryDrawer.test.tsx` and `src/server.test.ts` all exist and pass
- [ ] `grep -c '"typecheck"' package.json` returns `1` and `grep -c '"test"' package.json`
      returns at least `1`
- [ ] `git diff 2477929..HEAD -- tsconfig.json` is **empty** (no compiler flag was relaxed)
- [ ] `grep -rn "@ts-ignore\|@ts-expect-error\|@ts-nocheck" src/` returns no matches
- [ ] `bun run build` exits 0
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `bunx tsc --noEmit 2>&1 | grep -c "error TS"` reports a count other than 23 at the
  start (plan 001 may not have landed, or the tree has drifted). Report the actual count
  and output. `wc -l` reporting 24 is expected and is not a discrepancy.
- Clearing an error appears to require changing runtime behavior — a different status
  code, a different response shape, a new validation rejection. That is out of scope
  here; report the specific error instead.
- You are tempted to relax a `tsconfig.json` flag, or to add `@ts-ignore` /
  `@ts-expect-error` / `as any` to silence an error. Report the error instead; a
  suppressed error is worse than a listed one.
- `happy-dom` registration breaks `bun test` in a way you cannot resolve in two
  attempts. Report it — the storage and server tests do not need a DOM and can ship
  first.
- Any test you write fails for a reason that looks like a **real bug** rather than a
  test-harness problem. Report the bug; do not fix production code to make a test pass.

## Maintenance notes

- After this lands, `bun run typecheck` is the gate. Plans 003, 004 and 005 all assume
  it exits 0 before they start and after they finish.
- No CI runs these scripts yet — this plan adds the commands, not the automation.
  Wiring them into a pre-commit hook or GitHub Action is a deliberate follow-up, not
  planned here.
- A reviewer should scrutinize Step 3 and 4 specifically for behavior drift: every
  change there must be provably type-only. Any diff hunk that changes a status code,
  a response field, or a control-flow branch does not belong in this plan.
- `noUncheckedIndexedAccess` will keep producing TS2532 on new array indexing. That is
  working as intended — bind-then-guard is the house pattern established here.
