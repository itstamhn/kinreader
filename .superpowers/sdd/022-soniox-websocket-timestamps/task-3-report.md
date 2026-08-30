# Task 3 report — authoritative streaming integration

## Delivered

- Wired `App.tsx` to mint a scoped temporary key, open the browser-direct Soniox transport, feed independent audio/timestamp batches into `SpeechEngine`, and finalize timings only after protocol termination so timestamp messages trailing `audio_end` are retained.
- Added an injectable key requester and streaming transport at the App boundary. Production defaults remain the Task 1 cRPC action and Task 2 `openSonioxStream`; tests use protocol-controlled fakes while retaining the real React lifecycle, engine, and timing accumulator.
- Replaced the arriving timing prefix authoritatively and rebased the estimated suffix onto the last exact `end`, preserving rendered word count and monotonic joins. Termination flush requires exact 1:1 coverage or degrades to REST.
- Added one temporary-key-expiry retry from a reset engine/session. The second expiry, ordinary WebSocket failures, key issuance failures, and incomplete final timing coverage fall back to REST. A later REST media error falls through to browser speech; `error` is used only when browser speech is unavailable.
- Canceled sockets on article switches and unmount. Load generations suppress stale callbacks and invalidate a pending key request on unmount, while attempt-local activity guards suppress callbacks from a failed/retried socket.
- Kept server synthesis at 1.0: the WebSocket config still omits `speed`; REST explicitly uses `speed=1.0`; reader speed remains `audio.playbackRate`, and timestamps are never rate-scaled.
- Upgraded `SpeechEngine` streaming to prefer standard `MediaSource`, use guarded `ManagedMediaSource` only when standard MSE is unavailable/unsupported, and expose `progressivePlaybackAvailable` in both public state and snapshots.
- Added completed-Blob playback when neither source is available (or source-buffer setup fails), plus owned object-URL revocation, source listener removal, pending `SourceBuffer.abort()`, buffer/state clearing, and generation guards against late source events.
- Added `authoritativeTimings` state. Any array containing exact Soniox timings bypasses `calibrateToAudioDuration`; a final authoritative update adopts its exact duration. Existing audio-clock sync tests and expectations were left unchanged.
- Fixed the carried integration defect in the shared splitter: Soniox text messages are now contiguous bounded slices whose direct concatenation exactly equals the submitted trimmed text, including repeated spaces/newlines at chunk boundaries. Tests no longer use `join(' ')`.
- Extended the transport lifecycle with optional `onTerminated`, leaving `onDone` at `audio_end`; this gives integration code a reliable point at which all trailing timestamps have arrived before flushing.

## TDD evidence

### RED — exact transport text

After changing the splitter and transport assertions to direct concatenation and adding mixed-whitespace input:

```sh
bun test packages/backend/convex/shared/soniox.test.ts apps/web/src/utils/sonioxStream.test.ts
```

Result: 3 failures. The existing long-text case lost spaces at chunk boundaries, the mixed-whitespace case collapsed newlines/repeated spaces, and the transport case reconstructed a different string. The previous `join(' ')` assertion had hidden the defect.

### GREEN — exact transport text

The splitter now takes contiguous 450-character slices after one outer `trim()`:

```text
9 pass, 0 fail, 37 expect() calls
```

### RED — SpeechEngine streaming contract

Added tests before implementation for standard source preference/progressive capability, no-source completed-Blob playback, authoritative calibration suppression, and teardown:

```sh
cd apps/web && bun test src/utils/speechEngine.test.ts
```

Result: 12 existing tests passed and 4 new tests failed as intended:

- `startStreamingSession` returned `undefined` rather than capability state.
- setting `MediaSource` unavailable hit an unguarded global access.
- authoritative words were stretched from `0.25–1.4s` to `0.714–4s`.
- stop did not abort pending source work or revoke the owned URL.

The ManagedMediaSource-only branch was separately mutation-checked with the fallback temporarily absent:

```sh
cd apps/web && bun test src/utils/speechEngine.test.ts --test-name-pattern 'ManagedMediaSource'
```

Result: 1 failure, expected `true`, received `false`; restoring the guarded fallback made it pass.

### RED — App integration and lifecycle

Four App behaviors were added against injectable dependencies before wiring production:

```sh
cd apps/web && bun test src/App.test.tsx --test-name-pattern 'exact timestamp|switching articles|temporary-key expiry|WebSocket failure'
```

Result: 4 failures because zero WebSocket transports were opened. After the primary integration was green, two self-review gaps received their own RED runs:

- REST media errors only logged and never reached browser speech (`browserFallbackTexts` remained empty).
- resolving a pending temporary-key request after unmount opened one late socket instead of zero.

Both now have passing regressions.

### GREEN — focused integration

Run from `apps/web` so its required Bun DOM preload applies:

```sh
bun test ../../packages/backend/convex/shared/soniox.test.ts src/utils/sonioxStream.test.ts src/utils/wordTimings.test.ts src/utils/speechEngine.test.ts src/App.test.tsx
```

Result: **44 pass, 0 fail, 162 assertions**.

## Verification

```sh
cd apps/web && bun run typecheck
```

Passed: `tsc --noEmit`.

```sh
cd apps/web && bun run test
```

Passed: **70 tests, 0 failures, 218 assertions** across all 12 web test files.

```sh
cd packages/backend && bun run typecheck
```

Passed: `tsc --noEmit -p convex/tsconfig.json`.

```sh
cd packages/backend && bun run test
```

Passed: **53 tests, 0 failures, 179 assertions**, including REST 900-character compatibility and the new exact splitter cases.

`git diff --check` passed.

The web suite still prints pre-existing React `act(...)` notices; the new asynchronous App cases also exercise the same provider/update boundary. The intentional REST-error regression prints the engine's existing audio error log. These are warnings/logs, not failures.

## Files changed

- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`
- `apps/web/src/utils/speechEngine.ts`
- `apps/web/src/utils/speechEngine.test.ts`
- `apps/web/src/utils/sonioxStream.ts`
- `apps/web/src/utils/sonioxStream.test.ts`
- `packages/backend/convex/shared/soniox.ts`
- `packages/backend/convex/shared/soniox.test.ts`
- `.superpowers/sdd/022-soniox-websocket-timestamps/task-3-report.md`

## Self-review

- Confirmed fallback order is WebSocket → REST estimate/calibration → browser speech, with degraded status for every playable fallback and error only for no playable path.
- Confirmed the expiry retry creates a new accumulator and calls `eng.stop()` before requesting/opening the replacement session, preventing duplicated audio and words.
- Confirmed exact timestamps suppress global calibration even while an estimated suffix remains; the suffix alone is shifted, never the exact prefix.
- Confirmed final exact word text/count follows the rendered `split(/\s+/).filter(Boolean)` tokens, and termination is distinct from `audio_end` so the final partial word is flushed after trailing timestamp batches.
- Confirmed standard MSE wins when both constructors exist, ManagedMediaSource is type-checked before use, and source-buffer creation failure falls back to completed-Blob behavior.
- Confirmed source chunks are queued FIFO, end-of-stream waits until the queue drains, and teardown removes listeners before abort/end/revoke.
- Confirmed load/attempt generations prevent old sockets and late key promises from mutating a newer article or an unmounted App.
- Confirmed the existing audio-clock synchronization section was not modified.

## Concerns

- No live Soniox session or physical iPhone/ManagedMediaSource playback was run in this task; transport and lifecycle coverage use protocol-faithful fakes and source doubles. Manual device verification remains advisable for actual MP3 append compatibility and time-to-first-audio.
- Step 6 persistence/cache provenance remains intentionally out of scope; this task implements the requested first-play WebSocket path and fallback chain only.

## Review fix round 1 — delayed MediaSource failure after audio end

### Root cause

`finishStreamingSession()` built the completed Blob but installed its URL only when
`mediaSource` was already absent. If `audio_end` arrived while the source was still
waiting for `sourceopen`, the method returned with only the MediaSource URL attached.
A later `addSourceBuffer()` failure correctly cleaned up and revoked that URL, but the
completed Blob was no longer available to that transition, leaving `audio.src` pointed
at a revoked resource.

### RED

Added a delayed-source fake that accepts the MediaSource object URL, receives all audio
and `audio_end`, then emits `sourceopen` and throws from `addSourceBuffer()`. It emits the
event twice to verify Blob playback is installed exactly once.

```sh
cd apps/web && bun test src/utils/speechEngine.test.ts --test-name-pattern 'delayed source setup'
```

Result: **0 pass, 1 fail**. URL creation contained only `['media-source']`; the expected
completed `blob` URL was absent after cleanup.

### GREEN

Added an idempotent completed-Blob installation helper. Normal no-source completion still
uses it immediately. Delayed source-buffer failure uses the same helper after cleanup only
when completion was already requested, reconstructing the retained bytes and attaching one
playable Blob URL. The per-session installation guard resets in `stop()`, while existing
source listener cleanup and stream generation checks remain unchanged.

```sh
cd apps/web && bun test src/utils/speechEngine.test.ts --test-name-pattern 'delayed source setup'
```

Result: **1 pass, 0 fail, 5 assertions**. The MediaSource URL was revoked, one Blob URL
was installed, its bytes were `[4, 5, 6]`, and a repeated source event created no second
Blob URL.

```sh
cd apps/web && bun test src/utils/speechEngine.test.ts src/App.test.tsx src/utils/sonioxStream.test.ts src/utils/wordTimings.test.ts
```

Result: **42 pass, 0 fail, 158 assertions**. Existing React `act(...)` notices and the
intentional source-buffer warning remain non-failing diagnostics.
