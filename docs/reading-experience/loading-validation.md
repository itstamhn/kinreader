# Loading and recovery states

Implemented the Turn 2 handoff on September 5, 2026. The handoff is saved in rethink-handoff.md.

Fetching uses the host, a centered message, and a 64px ring. Audio preparation shows actual buffered listening seconds and a readiness bar. The ring becomes the normal transport when playback is available. Full Text can be opened during preparation. Saved-recording checks retain the existing Play now action.

Failures use a short message and Retry; the full reason remains in the tooltip. Estimated highlighting uses the amber notice. Failed links retain the sample reader and Dismiss. Completed preparation clears the old saved-audio notice so a truncation notice can appear. The first-use hint dismisses on Got it or first playback. Full Text preserves paragraph boundaries when source text aligns with the narration and fades beneath the controls.

Validation:

- 194 web tests passed, including loading-to-ready, loading-to-error, retry, saved-recording action, notice priority, hint persistence, and full-text word seeking.
- Web typecheck and production build passed.
- Browser checks used the actual React components with local fixtures. Fixture actions do not call Soniox or generate audio.
- Existing Soniox-only playback, buffering, seeking, and timing regression tests passed.

Local visual fixtures are available while Vite is running:

http://localhost:3001/dev/reader-states.html?state=preparing

Supported state values are fetching, preparing, saved, degraded, error, notice, truncated, hint, and full. This HTML entry is not included in the production build. Screenshots are saved alongside this note with the loading- prefix. The loading-reference.png image is from the supplied handoff.
