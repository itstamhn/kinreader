# Plan 014: Astro marketing site on the apex; the reader moves to `app.kinreader.com`

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise. This plan changes DNS-visible behaviour; read "Cutover" in
> full before starting Step 7.
>
> **Drift check (run first)**: `git diff --stat 10b792a..HEAD -- apps/ packages/ wrangler.jsonc`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH (the app changes origin — see "What breaks on the origin change")
- **Depends on**: `plans/013-bun-workspace-split.md` (needs `apps/`)
- **Category**: infrastructure / marketing
- **Planned at**: commit `10b792a`, 2026-08-29

## Why this matters

The reader has no front door. `kinreader.com` serves a JavaScript app shell with one
`<title>` and no indexable content, so there is nothing for search to rank and nowhere to
publish. A blog needs a static-site generator, and the app is not one.

The decision taken: **Astro owns the apex, the reader moves to `app.kinreader.com`.**

That split is not just a marketing choice — it is forced by what already lives on the
apex. `/r/:id` share pages and the `/api/og` card are crawler-facing surfaces on
`kinreader.com`, so once Astro serves that origin, those two routes **must** move with it
or existing share links 404. This plan therefore does what plan 009 was going to do, and
does it correctly: they become a static-site generator's job instead of escaped HTML
strings in a Worker (which plan 004 already had to go fix once).

## Current state

- `apps/web/` — the Vite SPA plus the Cloudflare Worker, served on `kinreader.com` and
  `www.kinreader.com` via `wrangler.jsonc` custom domains.
- `apps/web/src/server.ts` — Spiceflow, holding auth (`/api/auth/*`), `GET /api/og`, and
  `GET /r/:id`.
- `apps/web/src/worker.ts:37` — routes `/api` and `/r/` to Spiceflow, everything else to
  static assets.
- `apps/web/public/_headers` — the CSP and four security headers, with a documented
  sha256 hash of the inline redirect script in `index.html`.
- `packages/backend/` — Convex, unchanged by this plan.

Two things are true about the routes being moved, and the plan does not pretend otherwise:

1. **`/r/:id` is a half-built feature.** It renders OG/Twitter meta and then
   `<meta http-equiv="refresh">` to `/?read=<id>`. Nothing in the client reads `?read=`
   (`grep -rn "get('read" apps/web/src` → nothing), and nothing generates `/r/:id` links
   in the first place. Porting it preserves a URL contract that may exist in crawler
   caches; it does not deliver a working share feature. Finishing it is a separate plan.
2. **The OG card is an SVG, and the major crawlers do not render SVG.** X and Facebook
   want PNG or JPEG for `og:image`/`twitter:image`. The card almost certainly does not
   appear on any social platform today. Port it as-is here to keep this plan a move rather
   than a rewrite, and fix it in a follow-up (satori/resvg, or `astro-og-canvas`).

## Scope

**In scope**: the `apps/marketing` Astro app (landing, blog, RSS, sitemap), porting
`/r/:id` and `/api/og` into it, removing those two routes from the Worker, the
`app.kinreader.com` cutover, and the security headers for the new origin.

**Out of scope**:

- Auth (plan 008). Spiceflow and `/api/auth/*` stay on the app origin, unchanged except
  for the origin constants in Step 7.
- Deleting `src/server.ts`. After this plan it holds auth only; plan 009 removes it once
  008 lands.
- Making the share feature actually work, and re-rendering the OG card as PNG. Both are
  flagged above and belong in their own plans.
- Any shared `packages/ui` or design-token package. The marketing site **duplicates** the
  palette and font stack — see "Maintenance notes".

## Target topology

```
kinreader.com          → apps/marketing  (Astro SSR on Cloudflare)
  /                      landing
  /blog, /blog/[slug]    content collections
  /rss.xml, /sitemap     feeds
  /r/:id                 share page  (meta → app.kinreader.com/?read=<id>)
  /api/og                OG card
www.kinreader.com      → 301 to apex

app.kinreader.com      → apps/web        (SPA + Worker)
  /                      the reader
  /api/auth/*            Spiceflow auth, until plan 008
```

Two Cloudflare Workers, one Convex deployment, one repo.

## What breaks on the origin change

Read this before Step 7. Each item has a step; none of them is optional to *think* about.

1. **`localStorage` does not cross origins — ACCEPTED, no migration.** `kinreader_user`,
   `kinetic_saved_articles_v2`, `kinetic_reader_settings` and `kinreader_client_id` all
   live on `kinreader.com`, and on `app.kinreader.com` they are simply not there. The
   owner confirmed they are the only user with data on the apex, so the cost is one person
   signing in again and losing a library they can rebuild. A one-time iframe +
   `postMessage` bridge was specified here and **deliberately deleted**: it would have
   required relaxing `frame-ancestors` on the apex, a header plan 012 added on purpose, to
   migrate a single person's data. If this ever needs revisiting for real users, the
   history has the design.
2. **Installed PWAs point at the apex.** `manifest.json` has `"start_url": "/"` and
   `"display": "standalone"`, so an iOS home-screen install opens `kinreader.com/` and will
   land on the marketing page. Step 2 adds a standalone-mode redirect on the apex, which
   recovers them without the user reinstalling.
3. **Google OAuth is pinned to an origin.** `canonicalOrigin()` and `DEFAULT_APP_ORIGIN`
   in `apps/web/src/server.ts` (commit `fff13f2`) build the `redirect_uri` from
   `APP_ORIGIN`, and the state cookie is set on that origin. Both must become
   `https://app.kinreader.com`, and the Google Cloud console needs the new redirect URI
   registered **before** cutover or every sign-in fails with `redirect_uri_mismatch`.
4. **Existing share links keep working** — `/r/:id` stays on the apex. This is the one
   thing the subdomain split gets for free, and it is why the routes move to Astro rather
   than to the app subdomain.

## Steps

### Step 1: Scaffold `apps/marketing`

```bash
cd apps && bun create astro@latest marketing
```

Add the Cloudflare adapter and Tailwind. **Check the installed major version and follow
its current docs** — `bunx astro --version`, then the adapter and content-collections docs
for that version. Astro's content-collections API and adapter config have both moved
between majors; do not write either from memory, and do not copy a config from a blog post
without checking it against the installed version.

Name the package `@kinreader/marketing`. It needs no dependency on `@kinreader/backend` —
the marketing site talks to nothing.

**Verify**: `cd apps/marketing && bun run build` → exit 0. `bun run typecheck` from the
repo root still covers all three packages.

### Step 2: The landing page

Port the copy and metadata from `apps/web/index.html`: title, description, OG and Twitter
tags, favicons, `theme-color`. The apex is now the canonical URL for all of it.

Match the app's visual identity by **copying** the tokens, not by importing them:
background `#0B0C10`, accent `#F2A33C`, text `#ECEAE4`, surface `#14151C`; Instrument Sans
/ Newsreader / Spline Sans Mono from Google Fonts. Four hex values and three font names —
cheaper duplicated than coupled.

Add the PWA recovery redirect to the landing page `<head>`:

```html
<script>
  // Existing home-screen installs still open kinreader.com/ (manifest start_url).
  // Send only those to the app; a normal browser visit stays on the marketing page.
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    location.replace('https://app.kinreader.com/');
  }
</script>
```

This is an inline script, so it needs a CSP hash — see Step 8, and note the warning
already written at the top of `apps/web/public/_headers` about hashes silently breaking.

A prominent "Open the app" CTA to `https://app.kinreader.com` is the graceful path for
anyone who lands on the apex expecting the reader.

**Verify**: `bun run build`; the built HTML contains the OG tags and the redirect script.

### Step 3: Blog

Use Astro content collections with a `blog` collection under `apps/marketing/src/content/`
(check the installed version for whether the config belongs in `src/content/config.ts` or
`src/content.config.ts`, and whether a loader is required). Schema: `title`, `description`,
`pubDate`, optional `updatedDate`, `heroImage`, `draft` (default `false`, excluded from
production builds and from the feed).

Routes: `/blog` (index, newest first, drafts hidden) and `/blog/[slug]`.

Add `@astrojs/rss` at `/rss.xml`, `@astrojs/sitemap`, a `robots.txt` pointing at the
sitemap, and `site: 'https://kinreader.com'` in the Astro config so canonical URLs and the
feed resolve absolutely.

Ship **one** real post so the templates are exercised by content rather than by lorem.

**Verify**: build, then confirm `dist/` contains `blog/index.html`, the post, `rss.xml`
and `sitemap-index.xml`; a `draft: true` post is absent from all three.

### Step 4: Port `/r/:id`

An Astro dynamic route, server-rendered. Same URL contract, same meta tags. Two changes:

- The refresh target becomes `https://app.kinreader.com/?read=<id>`.
- Escaping is the template engine's job now. Astro escapes interpolated expressions by
  default, so the `escapeHtml` calls disappear — but `set:html` reintroduces the hole, so
  do not use it anywhere on this page.

Keep the `t`, `a` and `img` query parameters exactly as they are; a cached crawler URL is
the only consumer that matters.

**Verify**: port the four escaping tests from `apps/web/src/server.test.ts` (the
`</title><script>` payload, the attribute-breaking payload, the apostrophe, and the
ordinary-title case) to the marketing app. They must pass against the Astro route, then
stay in the suite. Do not delete them from the Worker tests until Step 6 removes the route.

### Step 5: Port `/api/og`

An Astro endpoint returning the same SVG with `Content-Type: image/svg+xml`. Move
`safeImageUrl` with it — the `javascript:` URL rejection is load-bearing (plan 004) and
must keep its test.

Port the SVG **byte-identical**. It does not render on X or Facebook (see "Current
state"), and that is a follow-up plan; changing the artwork here would mix a move with a
redesign and make both unreviewable.

**Verify**: the ported tests for the `<script>` payload in `title` and the `javascript:`
image URL pass. `curl` the built endpoint and diff the SVG against the Worker's output —
they should be identical.

### Step 6: Remove the two routes from the Worker

Delete the `/api/og` and `/r/:id` handlers from `apps/web/src/server.ts`, along with
`escapeHtml`/`safeImageUrl` and their now-duplicated tests. In `apps/web/src/worker.ts:37`,
drop `/r/` from the path match so only `/api` reaches Spiceflow.

Spiceflow **stays** — it still serves `/api/auth/*`. Plan 009 removes it after plan 008.

Add a straggler test in the same spirit as the existing `api/extract`/`api/tts` guard: no
file under `apps/web/src` may reference `/api/og` or `/r/`, so a missed call site fails
loudly instead of 404ing silently.

**Verify**: `bun run test` passes with the moved tests now living in
`apps/marketing`. The web suite's total drops by exactly the number of moved tests, and
the marketing suite gains them.

### Step 7: Cutover to `app.kinreader.com`

Order matters. Do the Google console change **first** and the DNS change **last**.

1. **Google Cloud console** — add `https://app.kinreader.com/api/auth/google/callback` as
   an Authorized redirect URI. Leave the apex one in place until the cutover is confirmed;
   removing it early is the failure mode.
2. **`apps/web/wrangler.jsonc`** — `routes` becomes a single custom domain,
   `app.kinreader.com`. `vars.APP_ORIGIN` becomes `https://app.kinreader.com`.
3. **`apps/web/src/server.ts`** — `DEFAULT_APP_ORIGIN` becomes
   `https://app.kinreader.com`. It is the fallback when `APP_ORIGIN` is unset; leaving it
   on the apex would silently send OAuth to the marketing site.
4. **`apps/marketing/wrangler.jsonc`** — custom domains `kinreader.com` and
   `www.kinreader.com`, with `www` 301ing to the apex.
5. **`apps/web/public/manifest.json`** — `start_url` stays `/`, which now resolves on the
   app origin. Update the app's own OG tags in `index.html` to point at the apex (the
   marketing site is the canonical shareable URL, not the app shell).
6. **`X-Robots-Tag: noindex`** on `app.kinreader.com` via `apps/web/public/_headers`. The
   app shell has no indexable content, and two origins competing for the same brand is a
   self-inflicted SEO problem.

**Verify** after deploying both Workers and before announcing anything:

```bash
curl -sI https://app.kinreader.com/api/health          # 200
curl -sI https://kinreader.com/ | grep -i content-type  # text/html from Astro
curl -sI https://www.kinreader.com/ | grep -i location  # 301 → apex
curl -s "https://kinreader.com/r/x?t=Test" | grep app.kinreader.com   # refresh target
```

Then sign in with Google end to end on a **real phone**, not a desktop emulator — that is
the flow this whole branch exists to protect.

### Step 8: Security headers for the marketing origin

Give `apps/marketing` its own `public/_headers` with the same five headers. The CSP is
where this step earns its keep:

- Astro emits inline scripts of its own (hydration, and view transitions if enabled), on
  top of the redirect script from Step 2. `script-src 'self'` alone will silently break
  them, exactly as the warning in `apps/web/public/_headers` describes.
- Prefer configuring Astro to emit **external** scripts over hand-maintaining sha256
  hashes. A hash list that must be recomputed on every content change will drift, and its
  failure mode is silent.
- `font-src` and `style-src` must permit Google Fonts, matching what the app already does.

**Verify**: load the built site under `wrangler dev` and confirm **zero** CSP violations in
the console — on the landing page, a blog post, and `/r/x?t=Test`. A single violation here
means the redirect script or a hydration island is dead.

## Test plan

- The four `/r/:id` escaping tests and the two `/api/og` tests move to `apps/marketing`
  and pass there. They are the reason plan 004 exists; losing them in the move is the
  worst realistic outcome of this plan.
- A new test that the `/r/:id` refresh target points at `app.kinreader.com`, not the apex —
  a self-redirect loop on the apex would be silent and would break every share link.
- A build assertion that a `draft: true` post is absent from `dist/`, the sitemap and the
  feed. Drafts leaking is the classic content-collection bug.
- The straggler test from Step 6.
- The existing web suite must pass unchanged apart from the moved tests.

## Done criteria

- [ ] `bun run build` builds all three packages
- [ ] `bun run test` passes; moved tests live in `apps/marketing` and the count is
      conserved across the two suites
- [ ] `kinreader.com` serves the Astro landing page; `/blog` lists one real post;
      `/rss.xml` and the sitemap are valid
- [ ] `www.kinreader.com` 301s to the apex
- [ ] `kinreader.com/r/:id` renders OG meta and points at `app.kinreader.com`
- [ ] `kinreader.com/api/og` returns an SVG byte-identical to the Worker's
- [ ] `app.kinreader.com` serves the reader; `/api/health` returns 200
- [ ] Google sign-in completes end to end **on a phone**, on the new origin
- [ ] Zero CSP violations on the landing page, a blog post, and a share page
- [ ] `app.kinreader.com` responds with `X-Robots-Tag: noindex`
- [ ] `grep -rn "kinreader.com/api/auth" apps/` finds no stale apex auth URL

## STOP conditions

- Google sign-in fails after cutover. Do **not** start editing `canonicalOrigin` under
  time pressure — check the registered redirect URI against `APP_ORIGIN` first; a
  mismatch there is the overwhelmingly likely cause and the code is now covered by tests.
- The CSP breaks Astro hydration and the fix on offer is `'unsafe-inline'`. That makes the
  policy decorative. Configure Astro to emit external scripts instead, or stop and report.
- The ported escaping tests do not pass against the Astro routes. Astro's default escaping
  should make them pass trivially; if it does not, something is using `set:html` and that
  is a live XSS, not a test problem.
- Anyone proposes to delete `src/server.ts` in this plan. Auth still lives there.

## Maintenance notes

- **Two origins is now a permanent property of the system.** Anything that assumes
  same-origin between the marketing site and the app — a cookie, a `fetch`, an iframe —
  needs an explicit CORS or `targetOrigin` decision. The auth cookie is scoped to the app
  origin and should stay that way; do not widen it to `.kinreader.com` to make something
  convenient work.
- **No shared design-token package.** The palette is duplicated on purpose. If the two
  sites visibly drift and someone is actually bothered, that is the moment to extract
  `packages/tokens` as CSS custom properties — from real drift, not in anticipation of it.
- **Two follow-up plans are now owed**, both flagged in "Current state": render the OG
  card as PNG so it appears on X and Facebook at all, and make the share feature real
  (generate `/r/:id` links in the client, and handle `?read=` on arrival). Neither is
  urgent; both are currently invisible failures, which is why they are written down.
- Plan 009 shrinks to "delete Spiceflow and `src/server.ts`" once plan 008 moves auth to
  Convex. This plan removed everything else it was going to cover.
