# Task 4 report — exact-track persistence, cache hits, provenance, and fallback completion

## Delivered

- Added optional `audioTracks.timingsSource` provenance with the literals `soniox` and `estimated`; existing rows remain schema-compatible.
- Added public cRPC query `tts.getExactTrack`, keyed by article URL/cache key and voice at fixed synthesis speed `1.0`. It returns only explicit Soniox provenance with full word-count coverage, monotonic finite timings whose final end matches duration, and a live non-empty `audio/mpeg` storage object. Legacy/missing provenance, estimated, truncated, invalid, and missing-storage rows are misses.
- Added rate-limited public cRPC mutation `tts.generateTrackUploadUrl`. It derives authenticated attribution server-side when available and otherwise uses the existing anonymous client key, then consumes the existing fixed global limiter plus the five-per-minute per-client path before calling `ctx.storage.generateUploadUrl()`.
- Added the browser three-step persistence flow: request upload URL, POST the completed MP3 `Blob` as the body with `Content-Type: audio/mpeg`, validate the `{ storageId }` response, then call `tts.persistTrack` without sending the Blob through a Convex function argument.
- Added strict internal mutation `finalizeExactTrack` with `v.id('_storage')`. It validates URL/cache key, article content, voice, finite duration, exact text/count/timing coverage, the 8192-word ceiling, and live audio MIME metadata before writing.
- Finalization creates or refreshes the article stub, upserts the fixed `voice + speed 1.0` track with exact duration/words and `timingsSource: 'soniox'`, and deletes a superseded stored file when it is distinct and still exists.
- Existing REST-produced rows are now explicitly marked `timingsSource: 'estimated'`; their existing cache/fallback behavior remains available, while the new exact cache path refuses them.
- `App.tsx` now follows exact cache → WebSocket → REST → browser speech. The cache query completes before client-ID/key issuance and socket creation. Cache media failure re-enters the WebSocket path.
- WebSocket completion retains the Blob returned by `finishStreamingSession()`, commits authoritative timings as ready, and starts persistence in a separately caught promise. Upload/finalize failure is logged and never replaces the already-playable exact audio with REST or browser speech.
- Regenerated the checked-in Convex and kitcn API/data-model bindings with the project-supported codegen command.

## TDD evidence

### RED — backend exact cache, upload gating, and finalization

Added focused Convex tests first for provenance invalidation, missing/truncated/deleted-storage misses, upload-limiter denial, exact upsert/replacement, superseded-file deletion, and non-storage ID rejection.

```sh
cd packages/backend
bun test convex/functions/routers/tts.test.ts --test-name-pattern 'exact cache lookup|track upload URL|exact track finalization'
```

Result: **0 passed, 4 failed**. All four failed at the missing public procedure references (`getExactTrack`, `generateTrackUploadUrl`, and `persistTrack`), confirming the requested backend surface did not exist.

### RED — App cache-first and persistence isolation

Added the App tests before wiring the new props or behavior.

```sh
cd apps/web
bun test src/App.test.tsx --test-name-pattern 'exact cache hit|persistence failure'
```

Result: **0 passed, 2 failed**. The cache audio URL never loaded (only the sample URL appeared), and completed WebSocket playback produced zero persistence calls.

### RED — browser upload flow

```sh
cd apps/web
bun test src/utils/exactTrackPersistence.test.ts
```

Result: **0 passed, 1 failed** because `exactTrackPersistence` did not exist.

### RED — required upload MIME

Self-review added a focused regression proving finalization must reject a storage object whose upload omitted `Content-Type: audio/mpeg`.

```sh
cd packages/backend
bun test convex/functions/routers/tts.test.ts --test-name-pattern 'required audio MIME|exact cache lookup|upserts at speed'
```

Result: **2 passed, 1 failed**; the missing-MIME finalization incorrectly resolved. Tightening the storage metadata check made the regression pass. Successful fixtures patch the `convex-test` system row because its direct storage helper records size/hash but omits the Blob MIME type, unlike the real browser upload endpoint.

### GREEN — focused suites

```sh
cd packages/backend
bun test convex/functions/routers/tts.test.ts
```

Result: **19 passed, 0 failed, 81 assertions**.

```sh
cd apps/web
bun test src/App.test.tsx src/utils/exactTrackPersistence.test.ts src/utils/speechEngine.test.ts src/utils/sonioxStream.test.ts src/utils/wordTimings.test.ts
```

Result before the final MIME-only backend refinement: **46 passed, 0 failed, 182 assertions**. The final full workspace run below includes the same web tree and passed 75 total web tests.

## Final verification

```sh
cd packages/backend
CONVEX_AGENT_MODE=anonymous npx convex dev --once
```

Passed against the local anonymous deployment: `Convex functions ready!`.

```sh
bun run typecheck
```

Passed for backend, web, and marketing with zero errors. Marketing retains eight existing Astro deprecation hints.

```sh
bun run test
```

Passed:

- Backend: **58 passed, 0 failed, 200 assertions**.
- Web: **75 passed, 0 failed, 247 assertions**.
- Marketing: **23 passed, 0 failed, 60 assertions**.

`git diff --check` also passed. Existing intentional network-fallback diagnostics, React `act(...)` notices, source-buffer failure logs, and marketing hints remain non-failing output.

## Files changed

- `packages/backend/convex/functions/schema.ts`
- `packages/backend/convex/functions/routers/tts.ts`
- `packages/backend/convex/functions/routers/ttsInternal.ts`
- `packages/backend/convex/functions/routers/tts.test.ts`
- `packages/backend/convex/shared/api.ts` (generated)
- `packages/backend/convex/functions/generated/procedure-names.gen.ts` (generated)
- `packages/backend/convex/functions/generated/routers/tts.runtime.ts` (generated)
- `packages/backend/convex/functions/_generated/api.d.ts` (generated)
- `packages/backend/convex/functions/_generated/dataModel.d.ts` (generated)
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`
- `apps/web/src/utils/exactTrackPersistence.ts`
- `apps/web/src/utils/exactTrackPersistence.test.ts`
- `.superpowers/sdd/022-soniox-websocket-timestamps/task-4-report.md`

## Self-review

- Confirmed the exact cache lookup is read-only and runs before `getOrCreateClientId`, temporary-key mutation, or streaming transport.
- Confirmed cache eligibility requires `timingsSource: 'soniox'`, exact `article.wordCount` coverage, speed `1`, valid monotonic timings/duration, and live MIME-qualified storage.
- Confirmed the public finalize wrapper never accepts a Blob and the internal finalize mutation enforces `v.id('_storage')` plus system-table existence and MIME checks.
- Confirmed upload URL issuance uses the shared fixed global boundary and the smaller per-client limiter; limiter denial occurs before `generateUploadUrl()`.
- Confirmed exact timing text is checked token-for-token against the finalized article, preventing a same-length but misaligned timing array from being cached as exact.
- Confirmed replacements use one indexed lookup, retain one row, and delete only a distinct superseded file that still exists.
- Confirmed REST synthesis remains available and stores estimated provenance; the HTTP fallback route was not removed.
- Confirmed exact completion is `ready`, while REST/browser fallbacks remain `degraded`, and persistence rejection only logs after playback is established.
- Confirmed generated artifacts contain all three public cRPC functions, the new internal functions and limiter purpose, and the optional schema field.
- A separate reviewer agent was not dispatched because this task explicitly prohibited subagents; the diff and requirement checklist were reviewed locally.

## Concerns

- No live Soniox session or real browser-to-Convex upload URL POST was run. The client upload contract is exercised with a real `Blob`/`Response` boundary fake, and the schema/functions were accepted by a local anonymous Convex deployment.
- The documented three-step upload flow has an unavoidable orphan window if the Blob upload succeeds and the browser disappears before finalization. Successful replacements clean up their superseded storage, while a future periodic orphan-storage policy could address interrupted uploads.

## Round 1 review fixes

### Delivered

- Replaced the raw-paste `sourceUrl || title` cache identity with `articleCacheKey`: real source URLs remain unchanged, while source-less notes use a `content-sha256:<hex>` key over the trimmed content. A deterministic browser-only fallback remains available if `SubtleCrypto` is absent. Cache lookup and persistence share the same derived key.
- Added `ttsUploadGrants`, indexed by token and expiry. Upload URL issuance now creates a distinct 256-bit CSPRNG capability with a ten-minute expiry only after both existing rate limiters accept the request, then returns that capability with the upload URL.
- Added an injectable `allocateTrackUploadAfterGrant` ordering boundary and a concrete allocation-call spy. A denied issuance throws before `ctx.storage.generateUploadUrl()` can be reached.
- Made `grant` mandatory in browser finalization and both public/internal Convex validators. `finalizeExactTrack` validates a live, unexpired grant and deletes it in the same mutation before any article or track write; transaction rollback preserves all-or-nothing behavior.
- Added `audioTracks.by_storage_id`. Finalization rejects any storage ID already referenced by a track, so even a newly issued grant cannot reuse one uploaded object for a second row.
- Replacements now query `by_storage_id` after the old row is replaced and delete the superseded object only when no remaining track references it. The same safety helper covers REST/internal track replacement.
- Regenerated the Convex/kitcn API, data-model, and procedure-name artifacts.

### RED

Web regressions were added before implementation:

```sh
cd apps/web
bun test src/utils/articleCacheKey.test.ts src/utils/exactTrackPersistence.test.ts src/App.test.tsx
```

Result: **16 passed, 5 failed, 1 module-load error**. The app still requested `Pasted Note`, different pasted content incorrectly loaded the same cache audio, finalization omitted the capability, and the content-key module did not exist.

Backend regressions were then added before implementation:

```sh
cd packages/backend
bun test convex/functions/routers/tts.test.ts
```

Result: **16 passed, 7 failed**. The allocation seam did not exist; missing grants resolved; `grant` was rejected as an unexpected field in intended-success cases; and the shared-storage and capability cases could not pass.

### GREEN

Focused backend result after implementation: **24 passed, 0 failed, 102 assertions**. This includes distinct/bounded 256-bit issuance, missing/wrong/expired/reused grant denial, no unauthorized article/track writes, cross-grant storage-ID reuse denial, allocation ordering, unique old-file deletion, and shared-reference retention.

Focused web result: **22 passed, 0 failed, 91 assertions**. This includes the fixed SHA-256 vector, same-title/different-content cache isolation, identical-content cache reuse, grant forwarding through the upload flow, cache-first behavior, and playable-audio preservation after persistence failure.

### Final verification

- `bun run test` in `packages/backend`: **63 passed, 0 failed, 221 assertions**.
- `bun run test` in `apps/web`: **78 passed, 0 failed, 264 assertions**.
- Backend and web `bun run typecheck`: passed with zero errors.
- `bun run codegen`: passed and regenerated checked-in artifacts.
- `npx convex dev --once --typecheck=disable --codegen=disable`: local-anonymous deployment accepted the schema/functions (`Convex functions ready!`).
- `git diff --check`: passed.

Existing non-failing React `act(...)`, intentional network-fallback, and SourceBuffer diagnostic output remains unchanged.

### Round 1 self-review

- Cache identity is derived before exact-cache lookup and before client ID creation, temporary-key issuance, or socket creation; the persistence path reuses the exact same key.
- The public capability contains 256 random bits, has a server-validated maximum ten-minute lifetime, is stored only after both limiter checks, and is removed transactionally before the first article/track write.
- Reusing the same grant fails because its row is gone; presenting a different grant cannot reuse an already referenced storage ID because `by_storage_id` is checked in the same transaction.
- Missing, wrong, expired, and reused grants leave article/track counts unchanged from their pre-call state.
- Replacement deletes the previous object only after the track row points at the new object and an indexed read proves no remaining reference exists.
- Persistence remains best-effort after the completed WebSocket Blob is playable, and REST/browser fallbacks remain intact.

## Round 2 review fix — abandoned grant cleanup

### RED

Added a real Convex issuance regression with 35 expired grants and two live grants. The expected behavior was a bounded cleanup of 32 expired rows, preservation of both live rows, and successful creation/allocation of the new grant.

```sh
cd packages/backend
bun test convex/functions/routers/tts.test.ts --test-name-pattern 'successful issuance removes at most 32 expired grants'
```

Result before implementation: **0 passed, 1 failed**. The assertion expected 3 expired grants to remain but observed all 35, proving the indexed expiry field was unused and abandoned grants accumulated.

### GREEN

- `issueTrackUploadGrant` now runs an indexed `by_expires_at` range query with `expiresAt <= now`, takes at most 32 rows, and deletes only that bounded batch.
- Cleanup runs after both existing limiter checks and before inserting the new grant. The public upload allocation still runs only after successful issuance, so the existing allocation-call spy remains load-bearing.
- Live grants are outside the index range and remain untouched. Repeated successful issuances drain a larger expired backlog in bounded batches.

Verification:

- Focused cleanup regression: **1 passed, 0 failed, 5 assertions**.
- Full TTS backend file: **25 passed, 0 failed, 107 assertions**.
- Backend `bun run typecheck`: passed with zero errors.
- `npx convex dev --once --typecheck=disable --codegen=disable`: local-anonymous deployment accepted the functions (`Convex functions ready!`).
- `git diff --check`: passed.
