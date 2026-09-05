# Handoff: Kinreader Reader — "Rethink" (option 1c)

## Overview
A minimal redesign of the Kinreader reader screen (the kinetic reading page). The words are the interface: no persistent header, one progress line, one time readout, and a control cluster that is visible while **paused** and fades to a single ghosted pause button + tempo while **playing**. Everything that is a preference (voice on/off, tempo ramp, theme, font size) moves to Settings; secondary per-article actions (Full text, Source, Share) become text links in the paused cluster or an overflow menu.

Target codebase: `src/App.tsx`, `src/components/Header.tsx`, `src/components/KineticDisplay.tsx`, `src/components/Controls.tsx`, `src/index.css` (React + Tailwind v4 `@theme` tokens). The redesign replaces `Header` on the reader view and slims `Controls`; `KineticDisplay` keeps its paging logic (`utils/editorialPages.ts`) with new styling.

## About the Design Files
`Kinreader Reader Review.dc.html` is a **design reference created in HTML**, not production code. It is a canvas with three options; implement **1c** only (the frames labelled `1c desktop paused` and `1c mobile playing`). 1a is the current build recreated for comparison; 1b is an intermediate polish pass. Recreate 1c in the existing React/Tailwind app using its current components and conventions.

## Fidelity
**High-fidelity.** Colors, type, sizes and spacing below are final. Match them exactly; use existing Tailwind theme tokens where they already exist (`--color-background`, `--color-accent`, fonts).

## Screens / Views

### Reader — paused (desktop, 1280×800 reference; fluid in practice)
Purpose: read/listen to one article. Paused state shows all controls.

Layout: single full-viewport column, `background:#0F110F` (one colour — remove the radial gradient and the `#111311` editorial paper; there is no longer a shell/pane seam). Contents are absolutely positioned around a vertically and horizontally centred text stage.

Components:
- **Progress line** — `position:absolute; top:0; left:0; right:0; height:2px; background:rgba(236,234,228,.08)`; fill `background:#F2A33C`, width = progress %. No glow, no rounded ends. This is the only progress indicator on the screen (delete the header progress line and the waveform scrubber). Clicking/dragging it seeks (reuse `handleTimelinePointerDown` from Controls.tsx); hit area should be ≥ 16px tall even though it paints 2px.
- **Back / library button** — top-left, `top:22px; left:24px; 40×40px`, no background, lucide `chevron-left` 18px, `color:rgba(236,234,228,.5)`. Opens Queue (`handleViewChange('queue')`).
- **Title line** — top centre, `top:32px`, one row, `font:Instrument Sans 12px`, `color:rgba(236,234,228,.45)`, gap 8px, separators "·". Content: `<author>` (weight 500, `color:rgba(236,234,228,.75)`) · `<title>` (truncate with ellipsis, max ~50% viewport) · `<remaining>` e.g. "13s left" (tabular numerals). Remaining = `(duration − currentTime) / rate`, formatted "Ns left" under 60s, "M min left" otherwise.
- **Top-right actions** — `top:22px; right:24px`, two 40×40 icon buttons, gap 6px, `color:rgba(236,234,228,.5)`: lucide `plus-circle` 18px (opens UrlInputModal) and lucide `ellipsis` 18px (overflow menu: Share link, Open source, Full text, Settings, Sign in/Account).
- **Text stage** — centred; `width:100%; max-width:880px; padding:0 88px; box-sizing:border-box`. `font-family:'Newsreader',Georgia,serif; font-weight:400; font-size:54px; line-height:1.5; letter-spacing:-0.012em`. Lines `white-space:nowrap` on desktop (existing measured paging). Word colours: spoken `#F4F0E6`, pending `#6e6f68`; transition `color 80ms linear`. Words remain buttons (click = seek to word). Font size settings map: sm 46 / md 54 / lg 62 px desktop.
- **Bottom cluster** — `position:absolute; bottom:40px; left:0; right:0`, column, centred, gap 22px.
  - Row 1 (transport), gap 36px: rewind-15 (existing 30×30 SVG arc icon at 26px, badge "15" 8px/600, `color:rgba(236,234,228,.5)`), **play button** 64×64 circle `background:linear-gradient(145deg,#FFBE5C,#E8930C)`, play/pause glyph `fill:#16130B` (play 22×24 offset 1px right; pause two 5.5×22 rounded rects) — **no box-shadow glow**, forward-15 (mirrored).
  - Row 2 (secondary), gap 24px, `font:Instrument Sans 12px; color:rgba(236,234,228,.45)`, "·" separators: tempo `Spline Sans Mono 12px/600 color:rgba(236,234,228,.75)` e.g. "1.5×" (click opens the existing speed popover; ↑/↓ still step 0.25) · "Full text" (toggles viewMode) · "Source" (opens sourceUrl, only if present) · page counter "1 / 5" (tabular, letter-spacing .08em).
- **Page navigation** — no visible arrows. ←/→ keys and horizontal swipe on the stage change page (existing key handler; add swipe). Remove the "Space play · ←→ pages · tap a word" hint; show it once as a dismissible toast on first visit (localStorage flag).

### Reader — playing (mobile, 390×800 reference; same rules apply to desktop while playing)
Layout: identical, `background:#0F110F`.
- Progress line: as above.
- Title line: `top:30px`, centred, `font-size:11px; color:rgba(236,234,228,.3)`, single line "`<author>` · `<remaining>`" (title omitted on mobile), `padding:0 60px`, ellipsis.
- Back and top-right actions: hidden while playing (fade out), reappear on pause or on tap of the stage.
- Text stage: `padding:0 28px; box-sizing:border-box; font-size:34px; line-height:1.5; letter-spacing:-0.012em`; lines wrap normally (`white-space:normal`). Font size settings map: sm 30 / md 34 / lg 38 px.
- Bottom cluster while playing: `bottom:44px`, row, centred, gap 18px, **opacity .35**: pause button 44×44 circle `background:rgba(255,255,255,.08)`, pause glyph `fill:#ECEAE4` 14×16; tempo "1.5×" `Spline Sans Mono 12px/600 #ECEAE4`. Rewind/forward and the secondary row are hidden while playing.

## Interactions & Behavior
- **Tap/click on the stage background** (not on a word) toggles play/pause. Space also toggles (existing).
- **Tap a word** seeks to that word (existing `onSelectWord`).
- **Chrome visibility**: two states. `paused` → full chrome (back, actions, title, transport, secondary row) at full opacity. `playing` → back/actions/transport/secondary fade out over 400ms ease-out after 1.5s of no pointer movement; the ghost pause+tempo (opacity .35) and progress line remain. Any pointer move/tap while playing shows the full chrome again for 3s. Respect `prefers-reduced-motion` (instant toggle).
- **Progress line** is the seek control; on hover (desktop) grow to 4px and show a small tooltip with time.
- **Page turn**: existing 100ms opacity entry; swipe left/right on touch.
- **Status banners** (degraded / error / loading progress / notices from Controls.tsx) render as a single line above the bottom cluster, `font 11px`, same colours as today (rose for error, amber for degraded, `rgba(236,234,228,.7)` for info). Keep their existing copy and actions ("Retry audio", "Play now", "Dismiss").
- **Empty / fetching state**: stage shows "Fetching article…" in `Instrument Sans 14px rgba(236,234,228,.4)` centred (existing).

## State Management
Reuse the engine snapshot from `useSyncExternalStore`. New UI state only:
- `chromeVisible: boolean` — derived: `!isPlaying || recentPointerActivity`.
- `hintDismissed: boolean` — localStorage `kinreader_hint_seen`.
- Remove `isVoiceEnabled` / `isRampEnabled` toggles from the reader; expose them in the Settings tab of `LibraryDrawer` (voice mute toggle, ramp toggle) and persist in `ReaderSettings`.
- `viewMode`, speed popover, seek handlers: unchanged.

## Design Tokens
Colours
- Background `#0F110F` (single reader background; replaces `#0B0C10` + `#111311` + radial)
- Spoken ink `#F4F0E6`; pending ink `#6e6f68`
- Chrome text: `rgba(236,234,228,.75)` primary, `.5` icons, `.45` secondary, `.3` ghost
- Progress track `rgba(236,234,228,.08)`; progress fill / accent `#F2A33C`
- Play button `linear-gradient(145deg,#FFBE5C,#E8930C)`, glyph `#16130B`
- Ghost pause circle `rgba(255,255,255,.08)`, glyph `#ECEAE4`
- Light theme (settings.readerTheme = light): background `#f4efe3`, spoken `#242720`, pending `#9a948a`, chrome text `rgba(36,39,32,.55)`, track `rgba(36,39,32,.1)` (accent unchanged)

Type
- Newsreader 400 — stage: 54/1.5 desktop, 34/1.5 mobile, letter-spacing −0.012em
- Instrument Sans — 12px chrome (desktop), 11px (mobile ghost line)
- Spline Sans Mono 600 — tempo 12px, counters tabular

Spacing / sizes
- Edge insets: 24px (desktop), 28px stage side padding (mobile), 88px stage side padding (desktop)
- Top chrome y: 22px buttons, 32px title (desktop) / 30px (mobile)
- Bottom cluster: 40px from bottom (desktop paused), 44px (mobile playing); row gaps 36 / 24 / 22px
- Hit targets: 40×40 icons, 64px play (paused), 44px pause (playing), 32px skip buttons
- Radius: full circles only; no cards
- Shadows: none (all glows removed)

## Assets
- Icons: lucide-react (already a dependency) — `ChevronLeft`, `PlusCircle`, `Ellipsis`. Skip-15 arcs and play/pause glyphs are the inline SVGs already in `Controls.tsx`.
- Fonts: Newsreader, Instrument Sans, Spline Sans Mono (already loaded by the app).

## Files
- `Kinreader Reader Review.dc.html` — the design canvas. Frames `[data-screen-label="1c desktop paused"]` and `[data-screen-label="1c mobile playing"]` are the spec; the critique panel at the far left lists the rationale for each removal.
- `support.js` — runtime the HTML file needs to open in a browser; not part of the design.
