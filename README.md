# ⚡ Kinetic Reader (Powered by Spiceflow)

A personal audio-visual speed-reader web app inspired by **Announcr.fm** and modern RSVP readers.

![UI Preview](https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80)

---

## Features

- **Kinetic RSVP Word Highlighting**: 60fps word-by-word active focus with scaled bold typography and surrounding word dimming.
- **Full Text Mode**: Toggle between sliding kinetic window and full article scroll view.
- **Diagram & Media Viewer**: Renders 2x2 matrices, infographics, and tweet attachments directly in the reader.
- **Dual-Engine Speech**:
  - **Free / On-Device (Default)**: Uses iOS Siri & macOS natural system voices with `SpeechSynthesis` word boundary tracking. Zero API keys or server costs required.
  - **Studio AI Mode (Optional)**: Connect your ElevenLabs API key for hyper-realistic cloned voices with millisecond timestamp synchronization.
- **Speed Modifier**: Adjust playback rate from `1.00x` to `2.50x` without audio distortion.
- **Content Extractor**: Paste any article, blog, Substack, or X/Twitter thread URL to instantly extract and listen.
- **PWA & iOS Ready**: Installable as a standalone, fullscreen iPhone app via Safari's **"Add to Home Screen"**.

---

## Quick Start

### 1. Run in Development
From the project folder (`/Users/tambot/Projects/kinetic-reader`):

```bash
bun run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## How to Install on iPhone (Full Screen App)

1. Run the dev server on your local network (`bun run dev -- --host`) or deploy to Cloudflare Workers / Vercel.
2. Open the URL in **Safari on your iPhone**.
3. Tap the **Share button** (square with an arrow pointing up).
4. Select **"Add to Home Screen"**.
5. The app will launch with a custom app icon in standalone full-screen mode without browser bars.

---

## Project Structure

```
kinetic-reader/
├── src/
│   ├── server.ts                 # Spiceflow API backend (Extract & TTS endpoints)
│   ├── App.tsx                   # Main reader state & layout container
│   ├── types.ts                  # TypeScript interfaces
│   ├── index.css                 # Tailwind CSS 4 styles & glow effects
│   ├── main.tsx                  # React entry point
│   ├── components/
│   │   ├── Header.tsx            # Author metadata, branding, and modals
│   │   ├── MediaCard.tsx         # Infographic/diagram viewer with lightbox
│   │   ├── KineticDisplay.tsx    # 60fps word-by-word synchronized RSVP reader
│   │   ├── Controls.tsx          # Play/pause, speed toggle, scrubber, & ETA
│   │   ├── UrlInputModal.tsx     # URL extractor & quick-demo loader
│   │   └── SettingsModal.tsx     # Voice engine & ElevenLabs API key settings
│   └── utils/
│       └── speechEngine.ts       # Audio synchronization & speech boundary manager
├── public/
│   ├── manifest.json             # PWA manifest
│   └── icon.svg                  # Vector app icon
├── vite.config.ts                # Vite & Spiceflow proxy config
└── package.json
```

---

## Deployment (Cloudflare Workers)

Spiceflow is built from the ground up for edge runtimes:

```bash
bunx wrangler deploy
```
