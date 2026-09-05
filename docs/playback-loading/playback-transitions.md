# Saved audio playback transitions

The durable player now plays each saved Soniox MP3 as an independent recording. It retains the server's section durations and word timings on one continuous timeline. This avoids filling a MediaSource buffer with a long article and replacing it with a concatenated MP3 during playback. No backend or stored audio migration is required.

Play intent is synchronous. Pause and source changes invalidate previous Play promises. A rejected request for an old source cannot stop the new source, and a late resolution cannot restart playback after Pause. Seeks that happen during metadata loading retain the latest requested offset. Finished recordings can restart with Play.

Saved progress is passed into the engine at session creation. Play stays unavailable until the resume word has exact timings and its audio is downloaded. Explicit rewind cancels that pending resume. Audio decode/load failures use the existing Soniox-only retry message.

## Verification

- The original pending-Play regression failed before the fix because the engine returned to playing after Pause.
- The production long article reproduced SourceBuffer QuotaExceededError before the fix. The new path uses 102 independent saved sections without MediaSource.
- Dia local preview using production recordings crossed four section boundaries at up to 3.5x with zero audio errors. Measured ended-to-playing transitions were 62–70 ms.
- Changed speed during playback, pressed rewind 20 times to reach zero, paused, and restarted. At 2x, media time advanced past four seconds, with the element playing and kinetic time within 10 ms of the audio clock at the check.
- Scrubbed to 55%, reloaded, and sampled readiness every 20 ms. The first ready position was word 6476 at 2402.729 seconds in section 56. No ready sample pointed to the opening. Playback then advanced to 2428 seconds.
- Regression tests cover stale Play resolution/rejection, independent section seeks before metadata, repeated rewind, speed changes, pending saved progress, cancelling resume, and the App's delayed-section resume path.
- All 303 tests pass. Typechecks and production builds pass. Existing Astro deprecation hints and bundle-size advice remain.

Detailed local traces and command output are saved alongside this document in ignored `.log` files.
