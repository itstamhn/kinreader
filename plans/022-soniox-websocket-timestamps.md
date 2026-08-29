# Plan 022: Real word timings from the Soniox WebSocket API

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise. **Step 0 has already been run — read its findings before
> Step 1. Step 4 is settled as 4a; do not implement 4b.**
>
> **Drift check (run first)**:
> `git diff --stat 83af051..HEAD -- apps/web/src/utils/speechEngine.ts apps/web/src/App.tsx packages/backend/convex/functions/http.ts`

## Status

- **Priority**: P2
- **Effort**: M (was L; Step 0 resolved the alignment risk — see findings below)
- **Risk**: MED-HIGH — replaces the audio transport for every article, and the
  browser gets a (short-lived, scoped) credential it does not have today
- **Depends on**: the sync fix already on `main` (kept as the fallback path)
- **Category**: correctness / architecture
- **Planned at**: 2026-08-29

## Why this matters

**Nothing in the current pipeline knows when a word is actually spoken.**
`packages/backend/convex/functions/http.ts:40` proxies Soniox's *REST* endpoint, which
returns raw MP3 bytes and nothing else. So `apps/web/src/App.tsx:186-208` invents the
timeline from a heuristic — `~0.042s per character, min 0.14s, max 0.44s`, plus fixed
punctuation padding — and the kinetic display has been highlighting against a guess since
the feature shipped.

Soniox does expose real timings, but only over the WebSocket API. Their docs are explicit
that this is not an oversight:

> The Soniox Text-to-Speech WebSocket API provides character-level timestamps... This
> feature is exclusive to the WebSocket API, as the REST endpoint streams raw audio
> without the necessary JSON envelope for alignment data.
> — https://soniox.com/docs/tts/rt/timestamps

The sync fix already on `main` made the highlight *follow* the audio faithfully and stretch
the estimate onto the real duration once it is known. That removes the runaway desync, and
it is worth keeping regardless of this plan. What it cannot do is fix *within-sentence*
pacing: a linear stretch corrects the total, not the rhythm. Step 0 measured the residual
after a perfect stretch at **median 0.34s, p90 0.61s** per word — against words that last
~0.34s at Soniox's real 177 WPM. The highlight sits a full word out of step half the time.
Only real timestamps fix that.

Two further wins fall out of the same change:

- **The 900-character truncation goes away.** `routers/tts.ts:69` caps synthesis at
  `MAX_SONIOX_SYNTH_CHARS = 900` and chops at a sentence boundary. The WebSocket API is
  incremental by design — text is streamed in as `{text, text_end}` messages — so a whole
  article can be sent without a cap.
- **Time-to-first-audio drops.** Audio generation begins on the first text chunk rather
  than after the whole request is synthesised.

## Verified API facts

All confirmed against the Soniox docs on 2026-08-29. Cited so the executor can re-check
rather than trust this file.

| Fact | Value | Source |
|---|---|---|
| WS endpoint | `wss://tts-rt.soniox.com/tts-websocket` | `/docs/api-reference/tts/websocket-api` |
| Timestamps opt-in | `"return_timestamps": true` in the first config message | `/docs/tts/rt/timestamps` |
| Config fields | `api_key`, `model`, `language`, `voice`, `audio_format`, `bitrate`, `stream_id`, `speed` | `/docs/tts/rt/timestamps`, `/docs/tts/concepts/speech-speed` |
| Client→server | `{"text": "...", "text_end": false, "stream_id": "..."}` | `/docs/tts/rt/real-time-generation` |
| Server→client | `{"audio": "<base64>", "audio_end": false, "stream_id": "..."}` | same |
| Timestamp payload | `timestamps: { characters[], character_start_times_seconds[], character_end_times_seconds[] }` | `/docs/tts/rt/timestamps` |
| Stream close | `{"terminated": true, "stream_id": "..."}` | `/docs/tts/rt/real-time-generation` |
| Temp key endpoint | `POST https://api.soniox.com/v1/auth/temporary-api-key` | `/docs/guides/temporary-api-keys` |
| Temp key body | `{usage_type: "tts_rt", expires_in_seconds, client_reference_id?, single_use?, max_session_duration_seconds?}` | `/docs/sdk/python-SDK`, `/docs/sdk/react-SDK/tts/realtime-speech-generation` |
| Temp key response | `{api_key, expires_at}` | same |
| Expiry error | `{error_code: 403, error_type: "temp_api_key_session_expired"}` | `/docs/guides/temporary-api-keys` |

Soniox's docs give two spellings for the key endpoint. **Step 0 settled it by trying both**:
`/v1/auth/temporary-api-key` (the guide's spelling) returns 201; `/v1/create_temporary_api_key`
(the API reference index's spelling) returns 404. Use the former.

## Step 0 findings — RUN 2026-08-29, both questions answered

Spike run against the live API with the real `SONIOX_API_KEY`, voice `Adrian`, model
`tts-rt-v2`, `audio_format: 'mp3'`, `return_timestamps: true`, no `speed` field. Two
samples: a deliberately awkward paragraph (abbreviation, currency, year, acronym, smart
quotes, decimal version, quarter) and 70 words of ordinary prose.

**Question A — do `characters` reconstruct the input verbatim? YES.**

Both samples round-tripped byte-identical, including the em dash and the straight quotes:
84/84 characters on the awkward sample, 414/414 on the prose. `Dr.`, `$4.2M`, `1990`,
`FBI`, `2.5`, `Q3`, `2026` all came back exactly as sent — Soniox reports the characters
you **submitted**, not a normalised spoken form. The feared `Dr.` → `Doctor` expansion does
not happen at this layer.

Better still, the naive mapping was verified end to end: skipping whitespace characters and
taking each word's first/last non-space character times produced **70 word timings that
align 1:1 with `content.split(/\s+/).filter(Boolean)`** — the exact tokenisation
`KineticDisplay` renders. No index shift.

→ **Step 4a. Delete Step 4b.** The alignment research risk is gone, and with it the
XL branch and the STOP condition.

**Question B — absolute or per-chunk times? ABSOLUTE.**

Start times rise monotonically across all 30 batches of the awkward sample, 0.282s →
12.459s. The second batch starts at 0.708s, nowhere near zero. No offset accumulation is
needed; use the numbers as they arrive.

**Three further findings that change the implementation:**

1. **Timestamps are decoupled from audio messages.** 39 audio messages arrived but only 30
   carried a `timestamps` object, and batches are fine-grained — 30 batches for 84
   characters, averaging 2.8 characters each, sometimes a single character (`"M"`,
   `"I"`). `SonioxStream` must therefore treat audio and timestamps as two independent
   streams: never assume a `timestamps` object accompanies an `audio` payload, and
   accumulate character batches separately from audio chunks.
2. **Leading whitespace attaches to the *following* token.** Batches read `" Chen"`,
   `" raised"`, `" ships"` — the space carries its own timestamp and belongs to the word
   after it. Taking `character_start_times_seconds[0]` of a batch as a word start would
   begin each word early, inside the preceding silence. Skip whitespace characters when
   determining a word's `start` (the verified mapping above already does).
3. **There is real leading silence.** The first spoken character begins at 0.111s (prose)
   and 0.282s (awkward). The estimate assumes 0. Minor, but it is a systematic head offset.

**What this proves about the current estimate — the finding that justifies the whole plan:**

| Sample | Real (Soniox) | Old heuristic | Error |
|---|---|---|---|
| 70 words of prose | 23.72s — **177 WPM** | 15.87s — **265 WPM** | 1.49× too fast |
| number/acronym-heavy | 12.46s — 82 WPM | 3.86s — 264 WPM | 3.23× too fast |

The heuristic's own comment claimed "~175 WPM"; it actually produced 265 WPM. Soniox's
Adrian voice really does run at 177 WPM, so the *intent* was right and the constants were
simply wrong — the words led the voice by ~50% from the first sentence, at every speed.
**Two fixes landed off the back of this, before any of the steps below:**

- `App.tsx` and `routers/tts.ts`'s `linearWordTimings` constants re-derived by ×1.495
  (`0.042→0.063` per char, `0.14→0.21` min, `0.44→0.66` max, punctuation likewise). The
  prose sample now estimates 23.80s / 176 WPM against a real 23.72s / 177 WPM.
- `calibrateToAudioDuration`'s accepted scale band widened from `0.4–2.5` to `0.3–4.0`.
  The number-heavy sample needs 2.15× even with the corrected constants, and the old
  ceiling would have silently refused to correct exactly the articles that need it most.

**And the measured limit of that approach — why this plan is still worth doing.** After a
*perfect* global stretch onto the true duration (the best `calibrateToAudioDuration` can
ever do), residual per-word error on the prose sample is **median 0.34s, p90 0.61s, max
0.75s**. At 177 WPM a word lasts ~0.34s, so the highlight sits a full word out of step half
the time and two words out at p90. That is precisely the "not following" the user reported,
and no amount of stretching removes it — only real timestamps do.

## Architecture decision

**The browser connects to Soniox directly, over its own WebSocket, authenticated with a
short-lived `tts_rt` temporary key that Convex mints.**

```
  browser                     Convex                        Soniox
     │  cRPC: tts.temporaryKey() │                              │
     ├──────────────────────────▶│  rate-limit, then POST       │
     │                           ├─ /v1/auth/temporary-api-key ▶│
     │   {api_key, expires_at}   │◀─────────────────────────────┤
     │◀──────────────────────────┤                              │
     │                                                          │
     │  wss://tts-rt.soniox.com/tts-websocket  (direct)          │
     ├─────────────────────────────────────────────────────────▶│
     │  ◀── {audio, timestamps} × N ─────────────────────────────┤
     │                                                          │
     │  on completion: tts.persistTrack({blob, words})           │
     ├──────────────────────────▶│  storage + audioTracks       │
```

Rejected alternatives, and why:

- **A Cloudflare Worker WebSocket bridge.** This was the assumed shape before the temporary
  key API turned up. It works, but it puts a stateful hop in front of every article,
  doubles the bytes across the wire, and adds a Durable Object (a plain Worker cannot hold
  a long-lived socket pair reliably). Temporary keys are Soniox's supported answer to
  exactly this problem — that is what `usage_type: 'tts_rt'` is *for*.
- **Proxying through Convex.** Not possible. A Convex `httpAction` handles request/response;
  it cannot hold a WebSocket to an upstream. This is the constraint that made the problem
  look harder than it is.
- **Keeping REST and synthesising timings from a forced-alignment model.** More moving
  parts and a second inference cost, to approximate data the WS API hands over free.

**The credential trade this makes**, stated plainly so it is a decision and not an
accident: today `SONIOX_API_KEY` never leaves the server. After this change, a key scoped
to `tts_rt`, expiring in 300s, is delivered to any browser that can reach the endpoint.
Step 2 is what keeps that from being an open tap.

## Speed stays a client-side concern

**Do not send the user's playback rate as Soniox's `speed`.** Two reasons, and the second
one is fatal:

1. Soniox clamps `speed` to `0.7–1.3` (the existing `http.ts:47` clamp is already written
   to that range). The reader's range is `0.8–3.5`.
2. Server-side `speed` bakes the rate into the audio *and its timestamps*, so every speed
   change would need a full re-synthesis — new key, new socket, new audio, and a stall on
   every tap of the speed control.

Synthesise at `speed: 1.0` and keep using `audio.playbackRate`. `currentTime` is media time
and the timestamps are media time, so they stay valid at every rate — which is precisely
the invariant the sync loop was rebuilt around
(`apps/web/src/utils/speechEngine.ts:570`). **The sync fix is a prerequisite for this plan
working at speed, not an alternative to it.**

## Step 0 — Spike (DONE 2026-08-29 — do not re-run)

Executed against the live API. Findings are recorded above; both original questions are
answered and **both STOP conditions are cleared**. Method, for provenance:

- Two texts through `wss://tts-rt.soniox.com/tts-websocket` with `return_timestamps: true`
  — one deliberately awkward (`Dr. Chen raised $4.2M in 1990. The FBI said "no" — twice.
  Version 2.5 ships Q3 2026.`) and 70 words of ordinary prose. Every `timestamps` payload
  dumped and compared against the submitted text.
- Word mapping implemented and checked against `content.split(/\s+/).filter(Boolean)`.
- The heuristic in `App.tsx` re-run over the same text and compared to the measured
  duration.

**Second STOP condition — cleared, and the architecture proven end to end.**
`POST https://api.soniox.com/v1/auth/temporary-api-key` with
`{usage_type: 'tts_rt', expires_in_seconds: 300, max_session_duration_seconds: 900,
client_reference_id}` returned **HTTP 201** and `{api_key, expires_at}` — a 147-character
key, distinct from the long-lived one, expiring five minutes out. That temporary key alone
then authenticated a WebSocket session that returned audio and timestamps. `usage_type:
'tts_rt'` is accepted on this account and the browser-direct design works.

**Endpoint spelling settled**: `/v1/auth/temporary-api-key` is correct.
`/v1/create_temporary_api_key` — the spelling in Soniox's API reference index — returns
**404**. Step 1 should use the former and need not probe.

## Step 1 — Mint temporary keys from Convex

Add `temporaryKey` to `packages/backend/convex/functions/routers/tts.ts`.

```ts
export const temporaryKey = action
  .input(z.object({ clientId: z.string().optional() }))
  .action(async ({ ctx, input }): Promise<{ apiKey: string; expiresAt: string }> => {
    // rate limit FIRST — see Step 2
    // POST https://api.soniox.com/v1/auth/temporary-api-key
    //   { usage_type: 'tts_rt', expires_in_seconds: 300,
    //     max_session_duration_seconds: 900,
    //     client_reference_id: <userId ?? clientId> }
  });
```

- Use `/v1/auth/temporary-api-key` — Step 0 confirmed it returns 201 while
  `/v1/create_temporary_api_key` 404s. Leave a comment saying the other spelling appears in
  Soniox's own API reference, so nobody "fixes" it back.
- `expires_in_seconds: 300` bounds how long a leaked key is useful;
  `max_session_duration_seconds: 900` bounds a single socket, so a long article cannot hold
  one connection open indefinitely. Both are ceilings, not targets.
- Set `client_reference_id` to the authenticated `userId` when there is one and the
  `clientId` otherwise, so Soniox's usage logs can attribute abuse.
- **Never** return `SONIOX_API_KEY` itself, on any code path including errors.

**Verify**: `bun run typecheck`; call the action from the Convex dashboard and confirm the
response contains a key that is *not* `SONIOX_API_KEY` and an `expires_at` ~5 minutes out.
Step 0 already confirmed the upstream shape: HTTP 201, a 147-character key, `expires_at` in
ISO-8601.

## Step 2 — Gate key issuance before it is a free tap

`synthesize` is protected by `ttsClientRateLimiter` and `ttsGlobalRateLimiter`
(`packages/backend/convex/lib/rateLimiter.ts`) and its own comments are candid that the
per-client one is "FAIRNESS ONLY, not a security boundary" because `clientId` is a
caller-supplied UUID. Key issuance inherits that weakness and raises the stakes: one
request now yields 5 minutes of direct Soniox access rather than one synthesis.

- Run **both** existing limiters on `temporaryKey`, before the Soniox call, using the same
  `consumeTtsRateLimit` mutation path. The global limiter is the one that actually holds.
- Tighten the per-client window for this endpoint — a client needs a key per *article*, not
  per request. Something like 5/minute is generous.
- Decide explicitly whether anonymous users get keys at all. If the product intends
  narration to require sign-in, this is the natural enforcement point and it is far
  stronger than any `clientId` bucket. **This is a product call — surface it, do not
  decide it silently.**

**Verify**: add a test in `routers/tts.test.ts` that a burst past the limit is rejected
*without* Soniox being called (assert on the mocked fetch).

## Step 3 — A `SonioxStream` client in the browser

New file `apps/web/src/utils/sonioxStream.ts`. Transport only — no engine knowledge, so it
is testable against a fake WebSocket.

```ts
export interface SonioxStreamHandlers {
  onAudio(chunk: Uint8Array): void;
  onTimestamps(t: { characters: string[]; starts: number[]; ends: number[] }): void;
  onDone(): void;
  onError(err: Error): void;
}
export function openSonioxStream(opts: {
  apiKey: string; text: string; voice: string;
  handlers: SonioxStreamHandlers;
}): { cancel(): void };
```

- Config message first: `{api_key, model: 'tts-rt-v2', language: 'en', voice,
  audio_format: 'mp3', bitrate: 128000, stream_id, return_timestamps: true}`. **`speed` is
  deliberately omitted** — see "Speed stays a client-side concern".
- Then `{text, text_end, stream_id}` messages. Reuse `splitTextIntoSonioxChunks` from
  `routers/tts.ts` for chunking, but **delete the `MAX_SONIOX_SYNTH_CHARS` truncation** —
  it exists only because the REST call was one-shot. Move the shared splitter to
  `packages/backend/convex/shared/` so both sides use one copy.
- Decode `audio` with `atob` → `Uint8Array`. Finish on `audio_end: true`; treat
  `terminated: true` as the close signal.
- Handle `error_type: 'temp_api_key_session_expired'` distinctly from a transport failure:
  it means re-mint a key and resume, not "fall back to REST".
- Cancel on unmount / article switch. A leaked socket keeps generating billable audio.

**Verify**: unit-test against a fake `WebSocket` that replays a captured Step 0 transcript.
Assert chunk order, that `text_end` is sent exactly once, and that `cancel()` closes.

## Step 4 — Characters → word timings

New file `apps/web/src/utils/wordTimings.ts`, pure and heavily unit-tested. **Step 0
settled this as variant 4a — characters come back verbatim, so this is a whitespace split,
not an alignment problem. The 4b edit-distance branch is deleted.**

Walk the character array accumulating a buffer. On a whitespace character, emit the buffered
word; otherwise append, taking `start` from the first **non-whitespace** character and `end`
from the last. Skipping whitespace for `start` is not a detail — Soniox attaches the leading
space to the following token (`" Chen"`, `" raised"`), so using the batch's first timestamp
would start every word inside the preceding silence.

The output must be index-aligned with `content.split(/\s+/).filter(Boolean)`, the
tokenisation `KineticDisplay` renders, because the engine addresses words by index. Step 0
verified this holds exactly (70/70 words on the prose sample); assert it in a test anyway,
since a silent off-by-one shifts the entire highlight.

Timestamps arrive incrementally and **independently of audio messages** (Step 0 finding 1:
30 of 39 audio messages carried none, batches averaged 2.8 characters). So this must be
resumable: fold each batch into the accumulated word list, keep a partial-word buffer across
batch boundaries, and hand the result to `engine.appendWordTimings`.

**Verify**: unit tests over the captured Step 0 transcript covering a batch boundary landing
mid-word, a single-character batch, and a batch that is only whitespace. Assert the
1:1 index alignment against `split(/\s+/)`.

## Step 5 — Wire the engine, and fix the MediaSource gap it exposes

The engine already has the scaffolding, unused since it was written:
`startStreamingSession` (`speechEngine.ts:221`), `appendAudioChunk`, `appendWordTimings`,
`finishStreamingSession`.

**Before using it, fix a latent bug in `startStreamingSession`.** It guards on
`'MediaSource' in window && MediaSource.isTypeSupported('audio/mpeg')`
(`speechEngine.ts:230`) and, when that fails, sets **no `audio.src` at all** — playback is
silently dead until `finishStreamingSession()` builds a Blob URL. That is the current state
on iPhone Safari, which has no `MediaSource` (iOS 17.1+ offers `ManagedMediaSource`
instead). Required behaviour:

1. Prefer `MediaSource`; use `ManagedMediaSource` where it is the only one present.
2. With neither, buffer every chunk and set a Blob URL once `audio_end` arrives. Higher
   time-to-first-audio, but it plays — and the word timings are still exact, which is the
   whole point of the plan.
3. Surface the degraded case through `playbackStatus` rather than swallowing it.

Then in `App.tsx:186-213`, replace the estimate-plus-REST path:

- Keep the heuristic estimate. It is still the right thing to show in the first few hundred
  milliseconds, before any timestamps land — `setWordTimings` at `App.tsx:208` already does
  this and should stay.
- Fetch a key, open the stream, feed `appendAudioChunk` / `appendWordTimings`.
- Real timings **replace** the estimate for the prefix that has arrived; the estimate keeps
  covering the tail. Rebase the untimed tail onto the last real `end` so the join does not
  jump backwards.
- Once real timings cover the whole article, `calibrateToAudioDuration()` must not fire —
  it exists to stretch a *guess*. Add an `authoritativeTimings` flag that suppresses it.

**Verify**: `bun run test`; then play a long article at 1×, 2×, and 3.5× and confirm the
highlight tracks the voice across all three. The existing sync regression tests
(`speechEngine.test.ts`) must still pass untouched — if this plan needs them changed,
something is wrong with the change, not the tests.

## Step 6 — Persist, and keep the fallbacks

- On completion, upload the Blob from `finishStreamingSession()` plus the real word timings
  through a new `tts.persistTrack` action into `audioTracks`
  (`schema.ts:91`) — the table already has `storageId`, `duration`, and `words`, and is
  already keyed `by_article_voice_speed`. Reuse it as-is.
- Add `timingsSource: v.optional(v.union(v.literal('soniox'), v.literal('estimated')))` so
  a cached track's provenance is visible and estimate-era rows can be invalidated. The
  existing `isStaleTruncated` check in `routers/tts.ts` is the precedent.
- On a cache hit, `loadAudioUrl` with the stored timings — no socket, no key, no cost.
- **Keep the whole existing chain as fallback**: cached track → WebSocket → REST
  `/api/tts/stream` (with the calibration fix) → browser speech synthesis. Each step down
  should set `playbackStatus` so a persistent WS failure is visible rather than a silent,
  slightly-worse experience.
- Do **not** delete the REST route in `http.ts`. It is the fallback and it is what serves
  browsers where the WS path cannot run.

## Risks

| Risk | Mitigation |
|---|---|
| ~~Normalised characters don't map to displayed words~~ | **Retired.** Step 0 proved characters round-trip verbatim and map 1:1 to the rendered tokenisation |
| Temp key abused to burn Soniox credit | Both limiters on issuance, 300s expiry, `max_session_duration_seconds`, `client_reference_id` in usage logs; possibly sign-in required (Step 2) |
| No MediaSource on iPhone Safari | Step 5's explicit buffer-then-Blob fallback — which also fixes today's silent failure |
| Socket leaks on rapid article switching | `cancel()` on unmount and on `loadIdRef` change; the existing stale-response guard at `App.tsx:109` is the precedent |
| Per-article cost rises (no server cache on first play) | Step 6 persists to `audioTracks`, so the second play of any article is free |
| Regressing the sync fix | Its tests are the contract; they must pass unmodified |

## Done criteria

1. `bun run typecheck` and `bun run test` pass from the repo root.
2. Playing a >2000-character article highlights in time with the voice at 1×, 2×, and 3.5×,
   with no drift-and-snap within sentences — the specific failure a linear stretch leaves
   behind.
3. Articles over 900 characters are narrated in full; the truncation is gone.
4. The browser never receives `SONIOX_API_KEY`; only `tts_rt` keys with an `expires_at`
   under 10 minutes. Confirm in devtools.
5. Replaying an article uses the cached `audioTracks` row: no temporary key is minted and
   no socket is opened.
6. With the WebSocket blocked (devtools request blocking), playback still works through the
   REST path and `playbackStatus` reflects the degradation.
7. `speechEngine.test.ts`'s sync tests pass unmodified.
