# Continuous audio storage

This Cloudflare Worker checks access to a saved recording and serves an existing HLS conversion from the private R2 bucket. Opening a recording is read-only. Narration completion schedules the optional conversion through Convex, and a missing conversion returns immediately so the reader can use saved MP3 sections.

The FFmpeg converter is `packages/backend/convex/functions/audioPackagingNode.ts`. Convex Workpool allows two simultaneous jobs. Each job uses one continuous AAC encoder, six-second fragments, exact decoded sample counts, and one initial AAC timing offset. Files are published before playlists reference them. Completed recordings are reused by content, voice, and recording ID.

The reader uses hls.js through MediaSource or ManagedMediaSource, including on Apple browsers where native HLS would switch to trick play above 2x. Completed HLS and MP3 sources start with about one listening second of real contiguous audio. Partial generation keeps the adaptive ten-second policy, and genuine underruns raise its refill target. Browser-managed buffering may resume with a smaller ready range when ManagedMediaSource has paused fragment loading.

Deploy the backend before the reader. This Worker needs `PACKAGER_SECRET`; Convex needs the matching `AUDIO_PACKAGER_SECRET` and `AUDIO_PACKAGER_ORIGIN`. Secrets belong in deployment configuration, never in source files. The reader connects through its `AUDIO_PACKAGER` service binding.

Commands run from the package directory.

```sh
bun run test
bun run typecheck
bun run deploy
```

The migration entries remove the unused Container class from the initial deployment attempt. Keep them when deploying updates.

A Convex Node action is limited to ten minutes. Packaging stops after eight minutes and leaves saved MP3s intact. Failed or unavailable packaging falls back to the existing saved-section player. Media tickets expire after 24 hours. No public R2 bucket is enabled.
