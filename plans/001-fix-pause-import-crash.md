# Plan 001: Import the `Pause` icon so the library drawer stops crashing during playback

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2477929..HEAD -- src/components/LibraryDrawer.tsx`
> If that file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `2477929`, 2026-08-28

## Why this matters

`src/components/LibraryDrawer.tsx` renders `<Pause />` but never imports it. `Pause` is
therefore an undefined identifier at runtime. React evaluates that JSX whenever the
library drawer is open **and** audio is playing, which throws
`ReferenceError: Pause is not defined`. There is no error boundary in this app, so the
throw unmounts the whole React tree — the user sees a blank page and loses their
reading position.

This ships today. Vite and esbuild do not resolve identifiers at build time, so the
bundle builds cleanly; only `tsc` catches it, and no script in `package.json` runs
`tsc`. Plan 002 adds that gate. This plan fixes the live crash first because it is a
one-line change and does not need the test harness that 002 introduces.

## Current state

- `src/components/LibraryDrawer.tsx` — the saved-articles drawer. Line 2 is the only
  `lucide-react` import; line 390 is the only use of `Pause` in the file.

Line 2 as it exists today — note `Play` is present, `Pause` is not:

```tsx
// src/components/LibraryDrawer.tsx:2
import { X, Play, Clock, Sparkles, Trash2, ArrowRight, Link as LinkIcon, Compass, Archive, History, Settings, ExternalLink } from 'lucide-react';
```

Lines 389-393 as they exist today:

```tsx
// src/components/LibraryDrawer.tsx:389-393
                {isPlaying ? (
                  <Pause className="w-3.5 h-3.5 fill-[#16130B] text-[#16130B]" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-[#16130B] text-[#16130B]" />
                )}
```

Repo conventions that apply here:

- Icons come from `lucide-react` as named imports on a single line at the top of the
  component file. `Pause` is a real export of `lucide-react` (v1.34.0, see
  `package.json` dependencies) — no version bump or dependency change is needed.
- Aliased imports use the `Original as Alias` form (see `Link as LinkIcon` on line 2).
  `Pause` needs no alias.

## Commands you will need

| Purpose   | Command                | Expected on success                          |
|-----------|------------------------|----------------------------------------------|
| Install   | `bun install`          | exit 0                                       |
| Typecheck | `bunx tsc --noEmit`    | no `LibraryDrawer.tsx` errors (others remain)|
| Build     | `bun run build`        | exit 0                                       |

Note: `bunx tsc --noEmit` currently reports 24 pre-existing errors across `src/App.tsx`,
`src/server.ts` and `src/utils/speechEngine.ts`. Those are **expected** and are fixed by
plan 002. This plan only removes the `LibraryDrawer.tsx` one. Do not attempt to fix the
others here.

## Scope

**In scope** (the only file you should modify):
- `src/components/LibraryDrawer.tsx`

**Out of scope** (do NOT touch, even though they look related):
- `src/App.tsx`, `src/server.ts`, `src/utils/speechEngine.ts` — they have their own
  `tsc` errors, addressed by plan 002. Fixing them here makes this change unreviewable.
- `package.json` — no new scripts or dependencies belong in this plan.
- Any other `lucide-react` import in any other component — only `LibraryDrawer.tsx`
  has this defect.
- The surrounding play/pause click handler logic on lines 380-395. The bug is a missing
  import, not a logic error. Do not refactor the handler.

## Git workflow

- Branch: `advisor/001-fix-pause-import-crash`
- The repo uses Conventional Commits. Example from `git log`:
  `refactor: make neural narrator built-in and remove api key configuration from UI`
- Suggested message: `fix: import missing Pause icon in LibraryDrawer`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `Pause` to the lucide-react import

In `src/components/LibraryDrawer.tsx`, add `Pause` to the named import on line 2.
Place it directly after `Play` to keep the play/pause pair adjacent:

```tsx
import { X, Play, Pause, Clock, Sparkles, Trash2, ArrowRight, Link as LinkIcon, Compass, Archive, History, Settings, ExternalLink } from 'lucide-react';
```

Change nothing else in the file.

**Verify**: `bunx tsc --noEmit 2>&1 | grep LibraryDrawer` → **no output** (exit 1 from
grep is the expected, correct result here — it means zero matches).

### Step 2: Confirm the identifier is genuinely bound

**Verify**: `grep -n "Pause" src/components/LibraryDrawer.tsx` → exactly two lines: the
import on line 2 and the JSX use on line 390.

### Step 3: Confirm nothing else regressed

**Verify**: `bunx tsc --noEmit 2>&1 | grep -c "error TS"` → `23` (was 24; only the
`LibraryDrawer.tsx` TS2304 error is gone).

Count errors with `grep -c "error TS"`, **not** `wc -l`. TypeScript wraps the
elaboration of `src/App.tsx(328,11)` onto a second physical line, so `wc -l` reports
one more than the true error count.

**Verify**: `bun run build` → exit 0.

## Test plan

No automated test is added here — this repo has no test harness yet, and standing one
up is plan 002's job. Adding it inside this plan would inflate a one-line fix into a
dependency change.

Plan 002 owns the regression test for this bug: a render test asserting
`LibraryDrawer` mounts with `isPlaying={true}` without throwing. That test is listed in
002's test plan; do not write it here.

Manual check (optional, only if a dev server is already running — do not start one just
for this):
1. Open the app, start playback.
2. Open the library drawer while audio is playing.
3. The row shows a pause icon and the app does not blank out.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bunx tsc --noEmit 2>&1 | grep -c LibraryDrawer` returns `0`
- [ ] `bunx tsc --noEmit 2>&1 | grep -c "error TS"` returns `23`
- [ ] `grep -c "Pause" src/components/LibraryDrawer.tsx` returns `2`
- [ ] `bun run build` exits 0
- [ ] `git status --short` shows `src/components/LibraryDrawer.tsx` as the only
      modified source file
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Line 2 of `LibraryDrawer.tsx` already contains `Pause`, or line 390 no longer
  references it — the codebase has drifted and this plan may already be done.
- `bunx tsc --noEmit` reports a **different** `LibraryDrawer.tsx` error after your
  change. That is a new problem, not this one.
- The distinct error count (`grep -c "error TS"`) after your change is anything other
  than 23. Report the actual count and the full output. Note that `wc -l` legitimately
  reports 24 — one pre-existing error wraps onto two lines — so judge by the error
  count, not the line count.
- You find other components with the same missing-import defect. Report them; do not
  fix them here (they are new findings, not part of this plan).

## Maintenance notes

- The real defect is process, not code: an undefined identifier reached production
  because nothing runs `tsc`. Plan 002 closes that hole. If 002 is dropped, expect this
  class of bug to recur.
- A reviewer should confirm the diff is exactly one line and touches only the import.
- Deferred out of this plan: the app has no React error boundary, so any render throw
  blanks the entire page. That is a separate hardening finding, not planned yet.
