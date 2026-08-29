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

```bash
bun install          # from the repo root — this is a Bun workspace
bun run dev          # Vite on :3000, the Spiceflow API on :3008
```

Open [http://localhost:3000](http://localhost:3000).

Convex runs from its own package:

```bash
cd packages/backend && bunx convex dev
```

---

## How to Install on iPhone (Full Screen App)

1. Run the dev server on your local network (`cd apps/web && bun run dev:web -- --host`)
   or deploy to Cloudflare Workers.
2. Open the URL in **Safari on your iPhone**.
3. Tap the **Share button** (square with an arrow pointing up).
4. Select **"Add to Home Screen"**.
5. The app launches with a custom icon in standalone full-screen mode without browser bars.

---

## Project Structure

A Bun workspace. Each package owns its own config and is deployed on its own.

```
kinreader/
├── apps/
│   └── web/                        # @kinreader/web — the reader
│       ├── index.html
│       ├── vite.config.ts          # Vite + the /api proxy to :3008
│       ├── wrangler.jsonc          # Cloudflare Worker + static assets
│       ├── bunfig.toml             # happy-dom preload for the web tests
│       ├── public/
│       │   ├── manifest.json       # PWA manifest
│       │   └── _headers            # CSP + security headers for static assets
│       └── src/
│           ├── worker.ts           # Cloudflare entry: HTTPS redirect, headers, routing
│           ├── server.ts           # Spiceflow: /api/auth/*, /api/og, /r/:id
│           ├── App.tsx             # reader state & layout
│           ├── types.ts
│           ├── components/         # Header, KineticDisplay, Controls, modals, drawer
│           ├── lib/                # convex client, storage, autosend
│           └── utils/speechEngine.ts
├── packages/
│   └── backend/                    # @kinreader/backend — the shared API
│       └── convex/                 # articles + tts routers, schema, kitcn cRPC
├── plans/                          # implementation plans and their execution log
├── tsconfig.base.json
└── package.json                    # workspace root
```

Root scripts fan out with `bun run --filter`: `bun run typecheck`, `bun run test`,
`bun run build`. Note that a bare `bun test` at the root does **not** pick up
`apps/web/bunfig.toml` — use `bun run test`.

---

## Deployment (Cloudflare Workers)

Spiceflow is built from the ground up for edge runtimes:

```bash
cd apps/web && bunx wrangler deploy          # the reader + its Worker
cd packages/backend && bunx convex deploy    # the backend
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
