# Plan 019: Fix the article-load lifecycle — a race, a dead sheet, and a state that can't be reached

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat 83af051..HEAD -- apps/web/src/App.tsx apps/web/src/utils/speechEngine.ts`

## Status

- **Priority**: P2 (one live race, one dead feature, one unreachable state)
- **Effort**: M
- **Risk**: MED (touches the load path, which plan 018 just stabilised)
- **Depends on**: — (018 is done; this builds on its status union)
- **Category**: bug
- **Planned at**: commit `d46a69b`, re-verified against `83af051`, 2026-08-29

## Why this matters

Plan 018 moved playback state out of React. It did not touch how an article gets *into*
the engine, and that path has three defects — all inside `loadArticleContent`
(`App.tsx:146-210`) and its callers, and all invisible to the 87 tests that currently pass.

**Bug 1 — the load race.** `loadArticleContent` is `async` and called fire-and-forget from
`handleLoadNewArticle` (`App.tsx:212`). Load article A, then pick B from the library before
A's synthesis resolves:

```
t0  load(A)  → eng.stop(); setWordTimings(A); await synthesize(A) ────────────┐
t1  load(B)  → eng.stop(); setWordTimings(B); await synthesize(B) ──┐         │
t2                                     B resolves → loadAudioUrl(B) ┘         │
t3                                     A resolves → loadAudioUrl(A) ──────────┘
```

At `t3` the reader hears article A while `article` state — and therefore the header, the
kinetic display's source, and the share modal — all say B. Nothing in the function checks
whether its own load is still the current one. The 9s `Promise.race` timeout does not help:
it rejects the race, but the underlying mutation keeps running and the `catch` at `:202`
then drives *B's* status to `degraded`.

**Bug 2 — `ClipboardDetectSheet` can never open.** `detectedClipboardUrl` (`App.tsx:92`) is
only ever written back to `''` (`:442`). Nothing anywhere in the app sets it to a URL, so
`isOpen={!!detectedClipboardUrl}` is permanently `false`. The component is 134 lines, has
its own 96-line test file, and those tests pass — the suite reports a working feature that
the application cannot reach.

**Bug 3 — `'error'` is declared but never assigned.** `PlaybackStatus` (`App.tsx:36-42`)
lists six states; `setPlaybackStatus` is called six times and never with `'error'`. The
`catch` at `:202` always falls through to `loadBrowserText` + `'degraded'`, and
`loadBrowserText` (`speechEngine.ts:205`) returns `void` whether or not there is a speech
synthesiser to fall back to — `playBrowserFromWord:227` just silently returns when
`this.synth` is null. So "we have no way to play this at all" renders identically to "neural
voice, all good". Plan 018 removed the impossible states; this removes the unreachable one.

018's execution log already recorded `'error'` as "known and accepted ... since the
on-device fallback always succeeds". **That premise is wrong**, which is why this is a bug
rather than tidying: `loadBrowserText` cannot fail loudly, but the playback it sets up can
be a complete no-op, and the code has no way to tell the two apart.

## Current state

- `App.tsx:146-210` — `loadArticleContent`, async, no cancellation, 5 `setPlaybackStatus`
  calls and 4 `eng.*` writes that can all land after a newer load has started.
- `App.tsx:212-217` — `handleLoadNewArticle`, the only caller, does not await.
- `App.tsx:92`, `:438-451` — the dead clipboard state and the sheet it gates.
- `App.tsx:36-42` — the status union, with one member no code can produce.

## Scope

**In scope**: cancellation for article loading, resolving the clipboard sheet's fate, and
making `'error'` reachable (or removing it).

**Out of scope**:

- The library's `localStorage` double-sourcing and the Convex playlist. That is plan 020,
  and it will rewrite `handleLoadNewArticle`'s persistence — do not pre-empt its design.
- The modal booleans and `settings`. Plan 021.
- URL state for the current article. Plan 016 owns `?read=`.
- Any change to `SpeechEngine`'s snapshot/notify contract. 018 settled that.

## Steps

### Step 1: Give article loading a cancellation token

`AbortController` is the instinct here and it does not fit: `synthesizeTtsMutation
.mutateAsync` takes no signal, and cRPC does not plumb one through to the Convex action. Use
a monotonic load token instead — the standard fix for exactly this shape.

```tsx
const loadTokenRef = useRef(0);

const loadArticleContent = async (art: ArticleData, eng: SpeechEngine, currSettings: ReaderSettings) => {
  const token = ++loadTokenRef.current;
  const isStale = () => loadTokenRef.current !== token;
  // ...
};
```

Then guard **every** write that happens after an `await` — both the `eng.*` calls and the
`setPlaybackStatus` calls. There are three points where control returns from a suspension:
after the `Promise.race` resolves (`:194`), inside the `catch` (`:202`), and at the
fallback (`:208`). A stale load must return without touching the engine or the status.

The writes *before* the first `await` (`eng.stop()`, `updateMediaSession`,
`setWordTimings`, `'timing'`, `'synthesizing'`) are safe: they run synchronously in call
order, so the newest load's values are the ones left behind.

**Verify**: this is the bug — reproduce it first. In `bunx vite dev`, load a slow article,
then immediately pick another from the library; before the fix the first article's audio
takes over, after it the second one holds.

### Step 2: Resolve the clipboard sheet

Two honest options. **Default: delete it.** The reason it was never wired is structural, not
an oversight — `navigator.clipboard.readText()` requires a user gesture and a permission
grant in every current browser, so there is no `focus`/`visibilitychange` handler that could
populate `detectedClipboardUrl` without either throwing or firing a permission prompt on
every tab focus. The gesture-triggered version of this feature already exists twice:
`UrlInputModal.tsx:150` and `LibraryDrawer.tsx:287`.

Delete `components/ClipboardDetectSheet.tsx`, `components/ClipboardDetectSheet.test.tsx`,
the `detectedClipboardUrl` state (`App.tsx:92`) and the JSX block (`:438-451`). The
`onAddToQueue` behaviour it carried is already duplicated on `UrlInputModal`
(`App.tsx:460-463`).

If instead the feature is wanted, that is a **new** entry point — a "paste a link" button
that reads the clipboard inside the click handler — and it belongs in its own plan with a
design, not bolted onto a `visibilitychange` listener here.

**Verify**: `grep -rn "detectedClipboardUrl\|ClipboardDetectSheet" apps/web/src` returns 0.
`bun run test` drops by the number of tests in that file and still reports 0 fail.

### Step 3: Make `'error'` reachable

Give the engine a way to say it cannot speak, and have the fallback branch believe it.

In `speechEngine.ts`:

```tsx
// Whether the on-device fallback is actually available. `playBrowserFromWord`
// silently no-ops without a synthesiser, so callers need to know *before*
// they present browser speech as a working fallback.
public get canSpeak(): boolean {
  return this.synth !== null;
}
```

In `App.tsx`, the tail of `loadArticleContent` becomes:

```tsx
if (!eng.canSpeak) {
  setPlaybackStatus('error');
  return;
}
eng.loadBrowserText(art.content, initialWordTimings);
setPlaybackStatus('degraded');
```

Then render it. `Controls.tsx` already takes `isDegraded` and shows a line for it; add
the sibling `isError` prop with a message that says playback is unavailable rather than
implying a slower voice. A reader who gets `'error'` currently sees a play button that does
nothing at all.

**Verify**: construct a `SpeechEngine` with `window.speechSynthesis` stubbed away and
confirm `canSpeak` is `false` and the status lands on `'error'`. `grep -c "'error'"
apps/web/src/App.tsx` returns at least 2 (the union member and the assignment).

## Test plan

The load path has no tests today, which is why all three of these survived plan 018's
review of the same file.

- **The race, asserted**: mount `App`, trigger two loads with the first mutation resolving
  after the second, and assert the engine ends up holding the second article's audio. Must
  fail against the current code — verify that before writing the fix.
- **A stale load cannot change the status**: same setup, assert `'ready'` is not re-entered
  by the first load's late resolution.
- **`canSpeak` is false without a synthesiser**, and a synthesis failure in that state lands
  on `'error'` rather than `'degraded'` — the mirror of the existing
  `App.test.tsx` degraded-status case.
- No new test for the clipboard sheet; its file is deleted with it.

## Done criteria

- [ ] A late-resolving load cannot write to the engine or the status
- [ ] `loadArticleContent` guards after every `await` — three sites
- [ ] `grep -rn "detectedClipboardUrl" apps/web/src` returns 0
- [ ] Every member of `PlaybackStatus` is assigned somewhere, and `'error'` renders
      differently from `'degraded'`
- [ ] `bun run typecheck`, `bun run test`, `bun run build` clean

## STOP conditions

- The token guard needs to move inside `SpeechEngine`. It does not — the engine has no
  concept of "which article is current", and giving it one duplicates `article` state.
  If it looks necessary, the fix has grown past this plan; stop and report.
- Deleting the clipboard sheet turns out to break an import chain beyond the four sites
  listed. Stop — something else uses it and this plan's premise was wrong.
- The race test cannot be made to fail against current code. Then the race is not real as
  described; report what you observed rather than writing a test that passes both ways.

## Maintenance notes

- The rule: **anything that awaits before writing to the engine needs a token check after
  every await.** Plan 020 adds more async writers to this path; they inherit the rule.
- `'error'` existing but unassigned was not sloppiness — it was written as the state the
  code *should* reach, in a plan that ran out of scope before reaching it. A union member
  with no producer is a to-do that typechecks; prefer reaching it or deleting it.
