# Plan 018: Stop mirroring the speech engine into React, and fix the two bugs that come with it

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat f5e5210..HEAD -- apps/web/src/App.tsx apps/web/src/utils/speechEngine.ts`

## Status

- **Priority**: P2 (two of these are live bugs)
- **Effort**: M
- **Risk**: MED (touches playback, which has no test coverage today)
- **Depends on**: —
- **Category**: bug / architecture
- **Planned at**: commit `f5e5210`, 2026-08-29

## Why this matters

`SpeechEngine` already owns the playback state: `words`, `duration`, `isPlaying`,
`currentWordIdx`, `rate`, `mode`. `App.tsx` then keeps a second copy of all of it in seven
`useState`s, fed by push callbacks, and hand-syncs `speed` back into `engine.rate` in three
separate places. Two live bugs fall directly out of that arrangement, and they are the
reason to do this now rather than to file it as tidying.

**Bug 1 — toggling ramp mode destroys the engine.** `App.tsx:125` constructs the engine
inside an effect that depends on `[isRampEnabled]`, and that flag is toggleable from the
header (`App.tsx:384`). Toggling it mid-article tears the engine down, stops playback, and
re-runs `engine.loadAudioUrl('/sample_audio.mp3', …)` — the reader lands back on the sample
audio with the article gone. The effect owns a long-lived external resource but takes a
reactive dependency; the callback only ever needs to *read* the flag.

**Bug 2 — the keyboard handler re-subscribes every frame.** `App.tsx:295` depends on
`[isPlaying, currentTime, duration, speed]`. `currentTime` is driven by `onProgressChange`,
which fires from a `requestAnimationFrame` loop (`speechEngine.ts:326-328`) in
browser-speech mode. A window listener is removed and re-added up to 60 times a second
while playing.

Both are the same root cause: React is being used to store state that already lives
somewhere else.

## Current state

```
SpeechEngine (owns the truth)          App.tsx (keeps a copy)
  words                        ──push──▶  useState words
  duration                     ──push──▶  useState duration
  isPlaying                    ──push──▶  useState isPlaying
  currentWordIdx               ──push──▶  useState currentWordIndex
  (derived progress/time)      ──push──▶  useState progress, currentTime
  rate                         ◀──sync──  useState speed   ← written back by hand, 3 places
```

- `App.tsx:95-125` — the engine effect, with `[isRampEnabled]` as its dependency.
- `App.tsx:99-113` — `setCallbacks(onWord, onProgress, onState)`, the push into React.
- `speed` is re-synced into `engine.rate` in `handleSpeedChange`, in the ramp callback
  inside the engine effect, and in `handleSaveSettings`.
- 24 `useState` calls in `App.tsx`; most are genuinely independent local UI and are **not**
  this plan's business.

## Scope

**In scope**: the engine lifetime bug, the keyboard subscription bug, consuming the engine
through `useSyncExternalStore`, and a playback status union to replace `isLoadingAudio`.

**Out of scope** — each is defensible on its own, none belongs in a change that touches
playback:

- Converting `App.tsx` to `useReducer` wholesale. Most of those 24 `useState`s are
  independent local UI; a single reducer would couple them for no gain.
- XState. The one real machine here is playback, and it already exists as a class with the
  imperative API `<audio>` requires. A second machine wrapping it adds a layer without
  removing one.
- Normalizing the library (`byId`/`allIds`). It is a short flat list keyed by `sourceUrl`;
  normalization would be ceremony for zero lookups saved.
- The six modal booleans and the `localStorage` double-sourcing of `settings` /
  `savedArticles`. Both are real (see "Deferred, deliberately") and both are safe to do
  later, separately from playback.
- URL state for the reader. That is plan 016's `?read=` — do not open a competing design.

## Steps

### Step 1: Fix the engine lifetime (Bug 1)

Give the effect an empty dependency array so the engine is constructed once. The ramp
callback needs the current flag, so read it from a ref that a small effect keeps current:

```tsx
const isRampEnabledRef = useRef(isRampEnabled);
useEffect(() => { isRampEnabledRef.current = isRampEnabled; }, [isRampEnabled]);
```

The callback then reads `isRampEnabledRef.current`. A ref is the right tool here precisely
because the value is *read during* an external callback rather than rendered.

**Verify**: load an article, start playback, toggle ramp from the header. Playback continues
and the article does not revert to the sample. This is the bug — confirm it by reproducing
it first on the current code.

### Step 2: Fix the keyboard subscription (Bug 2)

The handler needs `currentTime`, `duration` and `speed` only at the moment a key is pressed.
Read them from the engine inside the handler and drop them from the dependency array; the
listener then subscribes once.

**Verify**: with playback running, confirm the listener is added once rather than per frame
— a `console.count` in the effect body during development, removed before commit. Arrow
keys, space and the tempo shortcuts all still work.

### Step 3: Consume the engine as an external store

Add to `SpeechEngine` a `subscribe(listener): () => void` and a `getSnapshot()` returning a
**cached, referentially stable** object. Then in `App.tsx`:

```tsx
const playback = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getServerSnapshot);
```

The existing `setCallbacks` push becomes the internal notify — the engine's callbacks stay,
they just call the listeners instead of React setters.

**`getSnapshot` must return the same reference until something actually changes.** React
calls it on every render and will loop forever if it allocates a new object each time. Keep
a `#snapshot` field, replace it only inside the notify path.

This deletes `words`, `duration`, `isPlaying`, `currentWordIndex`, `progress`, `currentTime`
and the `speed`/`engine.rate` hand-sync. `speed` becomes `playback.rate`, and
`handleSpeedChange` only writes to the engine.

**Verify**: `bun run test` passes; playback, seeking, word highlighting and the tempo
controls all behave as before. `grep -c "useState" apps/web/src/App.tsx` drops by at least 6.

### Step 4: Give playback a status union

Replace `isLoadingAudio` with an explicit status. The states the code already moves
through, named:

```tsx
type PlaybackStatus =
  | 'idle'          // sample article, nothing loaded
  | 'timing'        // instant word timings computed, audio not yet requested
  | 'synthesizing'  // waiting on the Convex TTS action
  | 'ready'         // neural audio loaded
  | 'degraded'      // synthesis failed; on-device speech instead
  | 'error';        // nothing playable
```

`degraded` is the one that earns this step. `App.tsx:194` currently catches a synthesis
failure, `console.warn`s it, and silently falls back to the device voice — the reader cannot
tell a neural voice from a failure. Surface it: a quiet line in the controls is enough.

**Verify**: force the TTS path to reject and confirm the UI says so rather than silently
changing voice. `grep -c "isLoadingAudio" apps/web/src` returns 0.

## Test plan

Playback has no tests today, which is most of why these bugs survived. Add the cheap ones
this refactor makes possible:

- `getSnapshot` returns the identical reference across two calls with no intervening change.
  That is the `useSyncExternalStore` footgun, and it fails as an infinite render loop that
  is miserable to debug from a screenshot.
- `subscribe` returns an unsubscribe that actually detaches the listener.
- A happy-dom test that toggling ramp does not reconstruct the engine — Bug 1, asserted
  rather than remembered. It must fail against the current code; verify that first.
- The status union: a synthesis rejection lands in `degraded`, not `ready`.

## Done criteria

- [ ] Toggling ramp mid-playback does not stop playback or revert to the sample article
- [ ] The keyboard effect's dependency array no longer contains `currentTime`
- [ ] `App.tsx` no longer mirrors `words`, `duration`, `isPlaying`, `currentWordIndex`,
      `progress`, `currentTime`, or `speed`
- [ ] `engine.rate` is written in exactly one place
- [ ] `grep -c "isLoadingAudio" apps/web/src` returns 0
- [ ] A failed synthesis is visible to the reader
- [ ] `bun run typecheck`, `bun run test`, `bun run build` clean

## STOP conditions

- `getSnapshot` cannot be made referentially stable without restructuring the engine. Stop
  and report — returning a fresh object "for now" is an infinite render loop.
- Word highlighting drifts out of sync after Step 3. The rAF loop and React's render
  cadence are now decoupled; if timing degrades, that is a real regression and the
  60fps display is this product.
- The refactor grows to touch the modal booleans or `localStorage`. Both are out of scope
  and neither is worth entangling with playback.

## Deferred, deliberately

Found in the same review, real, and better done separately:

1. **Six modal booleans** (`isInputOpen`, `isSettingsOpen`, `isLibraryOpen`, `isAuthOpen`,
   `isClipOpen`) are mutually exclusive in practice but not in the type. One
   `activeModal` union. Pure UI, zero risk, no reason to bundle it with playback.
2. **`settings` and `savedArticles` are double-sourced** — `useState` seeded from
   `localStorage`, then written back by hand and manually re-read via
   `setSavedArticles(getSavedArticles())`. Another `useSyncExternalStore` case, on a
   storage store rather than the engine.
3. **Nothing about the reader is in the URL** — refresh loses the article and the position.
   That is plan 016's `?read=`, and `nuqs` is the natural fit if view mode and filters
   should follow.

## Maintenance notes

- The rule this plan encodes: **the engine owns playback state, React subscribes to it.**
  Any future `useState` that shadows an engine field is the same bug returning.
- `useSyncExternalStore`'s third argument (`getServerSnapshot`) is not optional here — the
  web app's tests run under happy-dom and the app is server-rendered by nothing today, but
  omitting it throws during hydration the moment that changes.
