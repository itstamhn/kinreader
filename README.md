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

---

## Google sign-in configuration

"Continue with Google" needs three things lined up, and a mismatch in any one of
them fails the sign-in on Google's own error page, before the browser ever comes
back to the app.

1. **Secrets on the Worker** — set once, per environment:

   ```bash
   bunx wrangler secret put GOOGLE_CLIENT_ID
   bunx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   With either one missing, the sign-in button now returns the user to the app
   with a visible "not configured yet" message instead of failing silently.

2. **`APP_ORIGIN`** (`wrangler.jsonc` → `vars`) — the one origin OAuth runs on.
   The `redirect_uri` is built from it rather than from the incoming request, so
   a visitor who arrives on `www.`, on `*.workers.dev`, or on a preview URL is
   sent to the canonical origin first instead of handing Google an unregistered
   redirect URI.

3. **The Google Cloud console** — under *APIs & Services → Credentials → OAuth
   2.0 Client ID*, the **Authorized redirect URI** must match `APP_ORIGIN`
   exactly:

   ```
   https://kinreader.com/api/auth/google/callback
   ```

   Add `http://localhost:3000/api/auth/google/callback` too if you want the flow
   to run in local development, and set `APP_ORIGIN=http://localhost:3000` in
   `.env` so the API server (which sees the Vite proxy's rewritten `Host`)
   builds the same URI.

Note that Google refuses OAuth inside embedded WebViews (`disallowed_useragent`),
so "Continue with Google" cannot work in the in-app browsers of X, Instagram,
LinkedIn or Slack no matter how the app is configured. The sign-in modal detects
those and points the user at Safari/Chrome or at email sign-in, which works
everywhere.
