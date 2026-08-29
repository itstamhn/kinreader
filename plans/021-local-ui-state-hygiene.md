# Plan 021: Settings stop round-tripping through the parent on every keystroke

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat 83af051..HEAD -- apps/web/src/App.tsx apps/web/src/components/LibraryDrawer.tsx apps/web/src/components/AuthModal.tsx`

## Status

- **Priority**: P2 (the settings cascade writes to `localStorage` on every slider frame)
- **Effort**: M
- **Risk**: LOW (pure client UI; no playback, no network, no auth logic)
- **Depends on**: — (order-independent with 019 and 020)
- **Category**: architecture / performance
- **Planned at**: commit `83af051`, 2026-08-29

## Why this matters

Plan 018 deferred "the modal booleans and the `localStorage` double-sourcing of `settings`"
as safe-to-do-later tidying. The UI rework in `41b26b1..83af051` — which deleted
`SettingsModal.tsx`, `ShareClipModal.tsx` and `MediaCard.tsx`, and moved settings into a tab
inside `LibraryDrawer` — changed that assessment. The double-sourcing did not go away; it
gained a second copy and two reconciling effects, and one of the paths now writes to disk
on a continuous input.

**The settings write-through cascade.** `LibraryDrawer` keeps its own copies of three
settings fields (`:86-88`), and syncs them back from the prop with an effect keyed on the
whole `settings` object (`:94-98`). Meanwhile every control writes both copies. The rate
slider's `onChange` (`:545-549`) is the worst case, because it fires continuously while
dragging:

```
drag frame
  → setDefaultRate(val)                    LibraryDrawer state
  → handleUpdateSettings({defaultRate})     :102, spreads the *prop*
     → onSaveSettings(updated)
        → setSettings(newSettings)          App state          (App.tsx:235)
        → localStorage.setItem(JSON…)       synchronous disk write, every frame
        → handleSpeedChange → engine.rate → notify → re-render
  → new `settings` object identity
     → LibraryDrawer effect :94-98 fires
        → setDefaultRate, setFontSize, setSonioxVoice   three more setStates
```

That is a `JSON.stringify` plus a synchronous `localStorage` write per pointer-move event,
and a round trip through the parent that lands back on the state the drag already set. It is
the playbook's cascading-effects anti-pattern (§5) with an I/O call inside the loop. The
displayed value happens to survive because the round trip is lossless today — but the
slider's position is being driven by a value that has been to the parent and back, which is
one merge change away from the thumb snapping.

**Two effects whose only job is reconciling copies.** `:90-92` syncs `initialTab` into
`currentTab`; `:94-98` syncs `settings` into three fields. Both are anti-pattern 2 (props
mirrored into state) plus 3 (an effect to paper over it). Neither is needed if the state has
one owner.

**The library is a route wearing booleans.** `App.tsx:349` reads
`isLibraryOpen ? <LibraryDrawer/> : <reader/>` — a full-screen swap, not an overlay. So
`isLibraryOpen` (`:87`) and `libraryTab` (`:88`) together encode three application views —
reader, library, settings — as a boolean plus an enum, with the same two-`setState` opening
sequence duplicated at each entry point (`Header`'s `onOpenSettings` and `onOpenLibrary`).
None of it is in the URL, so no view is linkable and the back button does nothing.

**`AuthModal` has two error stores and an effect between them.** `error` (`:38`) and the
`externalError` prop, joined by `shownError = externalError || error` (`:50`), kept mutually
exclusive by an effect (`:44-46`) pushing one way and `showError` (`:57`) the other. The
effect looks redundant on inspection: `shownError` already prefers `externalError`, so
clearing `error` when an external one arrives changes nothing that renders.

## Current state

- `App.tsx:61-76` — `settings` seeded from `localStorage` by hand.
- `App.tsx:234-239` — `handleSaveSettings`, writing React state and `localStorage` separately.
- `LibraryDrawer.tsx:86-88`, `:94-98`, `:102-105` — the third copy and its sync effect.
- `LibraryDrawer.tsx:509-512`, `:545-549` — the two controls that write both copies.
- `App.tsx:86-89` — `isInputOpen`, `isLibraryOpen`, `libraryTab`, `isAuthOpen`.
- `AuthModal.tsx:37-38`, `:44-46`, `:50-59` — the two-error arrangement.

## Scope

**In scope**: one owner for settings, one field for the current view, and `AuthModal`'s
error.

**Out of scope**:

- `savedArticles`. **Plan 020 owns it — do not touch `getSavedArticles`.** Fixing it here as
  a storage store is the competing design 020 exists to prevent.
- Putting the view in the URL. That is plan 016's territory (`nuqs`, `?read=`); Step 2 below
  deliberately stops at a single field, which is what 016 will need to lift into the URL.
- The `loading`/`error` pairs in `UrlInputModal` (`:42-43`) and `AuthModal` (`:37-38`). Same
  shape as the view booleans, two states wide, guarded by `try/finally`, and worth nothing
  today. Noted, not done.
- Anything in `SpeechEngine` or the load path (019).

## Steps

### Step 1: One owner for settings

Settings are external, persistent, and read by two components — the same shape as the
engine, so use the same tool. Add to `lib/storage.ts`:

```ts
export function subscribeSettings(listener: () => void): () => void
export function getSettingsSnapshot(): ReaderSettings
export function getSettingsServerSnapshot(): ReaderSettings
export function writeSettings(next: Partial<ReaderSettings>): void
```

**`getSettingsSnapshot` must return a cached, referentially stable object** — parse
`localStorage` once, hold the result, replace it only inside `writeSettings`. This is the
identical footgun plan 018 documented for `getSnapshot` and it fails the same way: an
infinite render loop. `speechEngine.test.ts:13` is the test to copy. Subscribing to the
`storage` event inside `subscribeSettings` gets cross-tab sync for free.

Then:

- `App.tsx` replaces the `useState` (`:61-76`) with `useSyncExternalStore`, and
  `handleSaveSettings` (`:234`) keeps only the rate application.
- `LibraryDrawer` drops `defaultRate`, `fontSize`, `sonioxVoice` (`:86-88`) **and the effect
  at `:94-98`**, reading `settings` from the prop and calling `writeSettings` on change.
  One write per change, no round trip, no reconciling effect.
- **Throttle the persist, not the state.** `writeSettings` should update the in-memory
  snapshot and notify immediately (so the slider stays responsive) and debounce the
  `localStorage.setItem` by ~200ms. That is the actual fix for the per-frame disk write;
  removing the cascade alone still leaves one write per pointer-move.

**Verify**: drag the rate slider across its full range and count `localStorage.setItem`
calls (spy on it in the console). Before: one per pointer-move event, dozens. After: a
handful. Settings changed in one tab appear in another.

### Step 2: One field for the current view

```tsx
type View = 'reader' | 'library' | 'settings';
const [view, setView] = useState<View>('reader');
```

`isLibraryOpen` and `libraryTab` both collapse into it; `LibraryDrawer` takes
`view` instead of `isOpen` + `initialTab`, and its `currentTab` state and the `:90-92`
effect both go — the parent already knows which tab is showing, so the child should not
keep a second answer. Each `Header` entry point becomes a single `setView('settings')`
instead of the current two-call sequence.

`isInputOpen` and `isAuthOpen` stay as they are: they are genuine overlays that render
*above* whatever view is current, and folding them into the same union would claim they are
mutually exclusive with the library when they are not. This is the distinction worth getting
right — a union for the thing that is a view, booleans for the things that float over it.

**Verify**: all three views reachable, settings opens directly on the settings tab from the
header, and the URL-input modal still opens over the library.

### Step 3: One error in `AuthModal`

Replace `error` and the `externalError` prop's separate storage with a single field:

```tsx
type AuthError = { source: 'local' | 'external'; message: string } | null;
```

The prop still arrives from `App.tsx` (the OAuth redirect reads `?auth_error`), so keep it
as an input — but one piece of state decides what renders, and the effect at `:44-46` then
has nothing to reconcile and is deleted.

Confirm it is genuinely redundant before deleting: produce an external error while a local
one is displayed and check what the user sees, with and without the effect. If it turns out
to matter, say so — this plan's premise on that point is an inference from reading, not an
observation.

**Verify**: a failed email sign-in, a failed sign-up, an `?auth_error=` redirect, and an
external error arriving while a local one shows — all display the right message.
`grep -c "useEffect" apps/web/src/components/AuthModal.tsx` returns 0.

## Test plan

All happy-dom, all cheap — this is the sort of thing that regresses silently.

- **`getSettingsSnapshot` returns the identical reference** across two calls with no
  intervening write. Copy `speechEngine.test.ts:13`. Without it, a mistake here is an
  infinite render loop that is miserable to debug.
- **The persist is throttled**: N rapid `writeSettings` calls produce one
  `localStorage.setItem`, while every one of them notifies subscribers. This is the
  regression the plan exists to prevent, so assert both halves.
- A settings change made in the drawer is visible to `App` without a round trip through a
  prop-sync effect (assert the effect is gone, not just that the value updates).
- Switching views leaves exactly one of reader/library/settings mounted.
- `AuthModal` shows an `?auth_error` message, and dismissing it clears it.

## Done criteria

- [ ] `settings` has exactly one owner; `LibraryDrawer` holds no copy and no sync effect
- [ ] `getSettingsSnapshot` is referentially stable, with a test that proves it
- [ ] Dragging the rate slider produces a bounded number of `localStorage` writes, not one
      per pointer-move
- [ ] One `view` field replaces `isLibraryOpen` + `libraryTab` + `currentTab`
- [ ] `AuthModal` has one error field and no `useEffect`
- [ ] `getSavedArticles` is untouched (plan 020 owns it)
- [ ] `bun run typecheck`, `bun run test`, `bun run build` clean

## STOP conditions

- The settings snapshot cannot be made referentially stable without restructuring
  `storage.ts`. Stop and report — do not return a fresh object "for now".
- Removing `LibraryDrawer`'s local copies makes a control feel laggy. That means the persist
  throttle is on the wrong side of the notify; fix the throttle rather than restoring the
  local copy.
- Step 2 needs two views at once (a settings pane beside the queue rather than instead of
  it). Then it is not a union, and the model in this plan is wrong — report it.
- The change reaches `savedArticles`, `SpeechEngine`, or the URL. All three belong to
  other plans.

## Maintenance notes

- The rule: **state has one owner.** A prop copied into `useState` plus an effect to
  resync it is two owners and a patch, and it is how the settings cascade got built —
  each half was reasonable on its own.
- The tell for this bug class is an effect whose dependency array is a whole object
  (`}, [settings]`). Object identity changes on every parent update, so the effect is
  really "run whenever the parent re-renders", which is never what anyone means.
- Settings stay client-only even after plan 020 puts the library in Convex — they hold API
  keys (`types.ts`), which do not belong in a synced table.
