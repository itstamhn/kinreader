# Plan 016: Make `/r/:id` a real share feature, and stop trusting its query string

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat f5e5210..HEAD -- apps/marketing/src/pages/r apps/marketing/src/lib packages/backend/convex`

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (a dead route becomes a live one; nothing existing depends on it)
- **Depends on**: `plans/015` (adds Convex procedures, so the layout should settle first)
- **Category**: feature / security
- **Planned at**: commit `f5e5210`, 2026-08-29

## Why this matters

`/r/:id` has been carried, escaped (plan 004), moved to Astro (plan 014) and tested — and
it has never worked. Two independent halves are missing:

```
$ grep -rn "get('read"  apps/web/src        # nothing handles ?read=
$ grep -rn '"/r/' apps/web/src              # nothing generates the links
```

The route renders OG tags and then forwards to `app.kinreader.com/?read=<id>`, which the
app ignores. Meanwhile `ShareClipModal.tsx:36` — the actual share button — posts
`article.sourceUrl || window.location.href` to X, so shares point at the *original*
article, not at Kinreader.

There is also a security dividend, and it is the better half of this plan. Today the card's
title, author and image arrive as **query parameters**, which is why `escapeHtml` and
`safeImageUrl` exist and why plan 004 had to go fix an XSS. Anyone can render arbitrary
text over Kinreader branding at `kinreader.com/r/x?t=…`. Reading those fields from a stored
record instead removes the attacker-controlled surface entirely rather than escaping it
more carefully.

## Current state

- `apps/marketing/src/pages/r/[id].astro` — reads `t`, `a`, `img` from the query string,
  emits OG/Twitter tags, `<meta http-equiv="refresh">` to `app.kinreader.com/?read=<id>`.
- `apps/marketing/src/lib/og-card.ts` — builds the card from the same query parameters.
  `escapeHtml`/`safeImageUrl` guard them.
- `apps/web/src/components/ShareClipModal.tsx:36` — `handlePostToX` builds a
  `twitter.com/intent/tweet` URL from the source article.
- `apps/web/src/App.tsx` — the mount effect reads `auth_token` and `auth_error`. Nothing
  reads `read`.
- `packages/backend/convex/schema.ts` — no table for shares.

## The design

A share is a **stored record**, not a URL full of parameters:

```
  reader                    Convex                     marketing (apex)
  ──────                    ──────                     ────────────────
  Share  ──create──▶  shares { id, title,     ◀──read──  /r/:id   → OG tags
                              author, image,             /api/og  → the card
                              sourceUrl }
                                  │
  /?read=<id> ◀──────────────────┘  resolve on arrival
```

Three properties fall out of it, and each is the reason to prefer this over passing richer
query parameters:

1. `/r/:id` and `/api/og` render **only** what Kinreader stored. The query-param surface,
   and the escaping it requires, goes away.
2. The link is short and stable — no title in the URL to be truncated by a client.
3. `?read=<id>` resolves to something real, so the forward actually lands the reader on the
   article.

**The cheaper alternative, and why not**: encode the source URL into the id
(`/r/<base64url(sourceUrl)>`) and re-extract on arrival. No table, no writes. But the OG
tags still need a title, so either the query parameters stay (keeping the XSS surface) or
every crawler hit triggers an extraction. Rejected on both counts. Note it here so the next
reader does not re-derive it.

## Scope

**In scope**: a `shares` table and its procedures, generating the link from the reader,
resolving `?read=` on arrival, and rewiring `/r/:id` + `/api/og` to read the store.

**Out of scope**:

- The MP4 export and the karaoke/voice toggles in `ShareClipModal`. This plan touches
  `handlePostToX` and adds a copy-link affordance; the clip pipeline is its own thing.
- Auth on shares. A share is public by construction — that is what a crawler fetches.
  Do not gate it on plan 008.
- Deleting `escapeHtml` / `safeImageUrl`. They stop being load-bearing for `/r/:id`, but
  `og-card.ts` still interpolates into an SVG string by hand. **Leave them.**

## Steps

### Step 1: The table

Add to `packages/backend/convex/schema.ts`:

```ts
shares: defineTable({
  slug: v.string(),          // short, URL-safe, what /r/:slug carries
  title: v.string(),
  author: v.optional(v.string()),
  image: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  createdAt: v.number(),
}).index('by_slug', ['slug']),
```

Generate `slug` with `crypto.getRandomValues` — the same reasoning as
`secureSixDigitCode` in plan 010. A sequential or timestamp id makes every share
enumerable, and shares are public by design.

**Verify**: `bunx convex dev --once` deploys; `bun run typecheck` exits 0.

### Step 2: The procedures

In `packages/backend/convex/routers/shares.ts` (or wherever plan 015 lands routers):

- `create` — mutation. Takes title, author, image, sourceUrl. Validates the image URL with
  the same host guard the extractor uses (plan 011) **before storing**, so a bad URL never
  reaches the card. Returns `{ slug }`.
- `get` — query. Takes a slug, returns the record or `null`. **Public and unauthenticated**
  — a crawler has no session.

Cap the stored strings (a title over ~300 characters is not a title) and rate-limit
`create` per client, mirroring plan 005's approach. A public write endpoint with no ceiling
is a storage bill waiting to happen.

**Verify**: `bunx kitcn codegen` picks up both procedures; a convex-test that `get` returns
`null` for an unknown slug and the record for a known one.

### Step 3: Read the store from the apex

`apps/marketing/src/pages/r/[id].astro` and `src/lib/og-card.ts` fetch the record by slug
instead of reading `t`/`a`/`img`.

The marketing app has no Convex client today — it deliberately talks to nothing (plan 014).
Adding one is the right call here, but keep it to a **plain HTTP query against the Convex
deployment**, not the reactive React client: these are two server-rendered routes on a
static site, and a subscription would be nonsense.

Behaviour when the slug is unknown: render the generic Kinreader card and link to the app.
**Do not 404** — a share link that has expired should still show something Kinreader-shaped
rather than a dead page in someone's timeline.

**Verify**: the ported escaping tests still pass. Add one that an unknown slug renders the
generic card rather than erroring. `?t=` is no longer read anywhere — `grep -rn "get('t')"
apps/marketing/src` returns nothing.

### Step 4: Generate the link in the reader

`ShareClipModal.handlePostToX` calls `shares.create`, then posts
`https://kinreader.com/r/<slug>` to X rather than the source URL. Add a **Copy link**
button beside it that does the same thing without leaving the app — that is the share most
people actually want, and it is two lines once `create` exists.

Handle the failure: if `create` fails, fall back to the current behaviour (post the source
URL) rather than blocking the share. A share that degrades is better than a button that
does nothing — the same reasoning that put an SVG fallback behind the PNG card.

**Verify**: a test that the posted URL is `kinreader.com/r/<slug>` on success and the source
URL when `create` rejects.

### Step 5: Resolve `?read=` on arrival

In `apps/web/src/App.tsx`, beside the `auth_token` / `auth_error` handling: read `read`,
strip it from the URL with `replaceState` (same as the others), fetch the share, and load
the article from its `sourceUrl` through the existing extract mutation.

Show the loading state the URL modal already uses. A silent five-second pause on a cold
link is how this looks broken to someone arriving from a tweet.

**Verify**: a happy-dom test that `/?read=abc` triggers the fetch and leaves the address bar
clean; and that an unknown slug leaves the app on the sample article rather than blank.

## Test plan

- The two convex-test cases from Step 2, including the unauthenticated read.
- The unknown-slug render from Step 3 — the case a real expired link will hit.
- The `create`-fails fallback from Step 4.
- The `?read=` mount effect from Step 5, both paths.
- The existing escaping tests must keep passing. They are no longer the last line of
  defence for `/r/:id`, but `og-card.ts` still builds an SVG by hand.

## Done criteria

- [ ] `grep -rn "get('t')" apps/marketing/src` returns nothing — the card reads the store
- [ ] `grep -rn "read" apps/web/src/App.tsx` shows the param being handled
- [ ] Sharing from the reader produces a `kinreader.com/r/<slug>` link
- [ ] Opening that link shows the right OG card and lands on the article in the app
- [ ] An unknown slug renders the generic card and does not 404
- [ ] `bun run typecheck`, `bun run test`, `bun run build` all clean

## STOP conditions

- The marketing site needs the reactive Convex client to make Step 3 work. It should need
  one HTTP query. If it does not, stop — pulling the React client into a static site is a
  bigger decision than this plan.
- `shares.create` cannot be rate-limited with the existing approach. Do not ship a public,
  unlimited write.
- Resolving `?read=` needs auth. It must not: the whole point is that a stranger can open
  the link.

## Maintenance notes

- Shares are public, permanent and enumerable-by-guessing-only. If that ever needs to
  change (expiry, deletion, private shares), it is a schema change plus a filter, not a
  redesign — but decide before there are many of them.
- The card is still an SVG rasterised to PNG from hand-built markup. Reading the store
  removes the *attacker-controlled* inputs; it does not make string interpolation safe in
  general. Keep `escapeHtml` where it is.
