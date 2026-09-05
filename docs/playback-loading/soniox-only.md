# Soniox-only playback

On September 5, 2026, the user reported this message after opening an article:

> Neural voice unavailable (using on-device speech). Reason: the audio fallback could not be loaded.

The compatibility WebSocket/REST path still invoked device speech after an audio error. A regression test reproduced that switch. The normal durable path in the deployed reader did not reproduce it on a fresh open of the supplied link, which suggests an older loaded app version was involved. The user's original tab version was not captured.

The reader now has no calls to `loadBrowserText`. Soniox audio failures, including asynchronous sample-file errors and compatibility-path failures, produce an error with **Retry audio**. A failure pauses playback and retains available audio and the reading position. It never selects a device voice. The estimated-timing notice describes only Soniox audio with estimated timings.

Verification used [the supplied pvncher article](https://x.com/pvncher/status/2095991462416490862), titled “Rethinking skills and prompts for GPT-6 Astra”. Its 907 words were prepared as nine saved Soniox sections.

- The original regression failed because `loadBrowserText` was called after a simulated REST audio error. It passes after the fix.
- Tests also cover server preparation failure, explicit retry, and asynchronous sample audio failure.
- In the production browser, the first saved audio download was deliberately blocked. The reader offered Retry audio and invoked device speech zero times. The block was removed, and Retry loaded the saved recording successfully.
- Production playback used audio mode and authoritative Soniox word timings. All nine sections were saved and the browser opened no Soniox WebSockets.
- All 299 tests passed, workspace type checks passed, and the web production build passed.

Run from the project root:

```sh
bun run test
bun run typecheck
bun run --cwd apps/web build
```

An already-open old tab must be refreshed to load the new JavaScript. Production HTML already has `max-age=0, must-revalidate` cache headers.
