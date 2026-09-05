# Reader rethink validation

Implemented option 1c from the supplied design handoff on September 5, 2026.

The reader uses the supplied background, ink colors, Newsreader sizes, spacing, top seek line, paused transport, and idle pause/tempo controls. The desktop sample has the same three line breaks as the design. A fixed three-line stage preserves the first-line position on shorter pages.

Soniox playback and measured pagination remain in place. Voice and gradual tempo increase are persisted in Settings. Theme selection affects the entire reader. The overflow menu includes sharing, source, Full Text, Settings, and account access.

Validation completed locally:

- Web typecheck and production build passed.
- All 188 web tests passed, including new tests for idle controls, ghost pause, persistent hint dismissal, and swipes that do not also seek words.
- Dia browser checks at 1280 × 800 and 390 × 800 covered the desktop and mobile layouts, actual saved Soniox playback, idle fade and pause, tempo menu, word seeking, Full Text, and light/dark settings.
- Existing Soniox-only, replay, timing, buffering, and seeking regression tests passed.

Screenshots in this folder:

- rethink-reference-desktop.png is the handoff's desktop frame.
- rethink-desktop.png is the implemented reader using the same sample text.
- rethink-mobile-playing.png is the implemented reader playing the user's saved article.

Article titles, progress, remaining time, page counts, and audio status reflect real content and therefore differ from the static reference. The mobile screenshot includes the existing saved-audio status.
