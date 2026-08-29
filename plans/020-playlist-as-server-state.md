# Plan 020: Make the Convex playlist real — the library becomes server state, `localStorage` becomes a cache

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat 83af051..HEAD -- packages/backend/convex/functions/routers/users.ts apps/web/src/lib/storage.ts apps/web/src/App.tsx`

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED-HIGH (first write path that spans auth, the article table, and the client cache)
- **Depends on**: 008 (done), 019 (the load path must stop racing before more async lands on it)
- **Category**: architecture / feature
- **Planned at**: commit `d46a69b`, re-verified against `83af051`, 2026-08-29

## Why this matters

`packages/backend/convex/functions/routers/users.ts` contains a complete, correctly
authorised cloud library: `getUserPlaylist` (`:36`), `saveUserProgress` (`:68`),
`deleteUserArticle` (`:116`). Plan 008 closed the authorisation hole in all three and they
were reviewed and confirmed.

**The web app calls none of them.** There is not a single `useQuery` in `apps/web` — four
`useMutation`s and nothing else. The library lives entirely in `localStorage`
(`lib/storage.ts`), read imperatively through `getSavedArticles()`.

So: you sign in, you add ten articles, you open the app on your phone, and the library is
empty. Reading progress is not synced either — `userArticles` has `progress`,
`lastWordIndex`, `currentTime` and `isCompleted` columns that no client ever writes.

This is the state-management playbook's tier 1 (§3): data that is fetched from a backend,
owned remotely, and shared across a user's devices belongs in a server-state manager, not
in a local copy. TanStack Query is already wired (`lib/convex.tsx`) and the Convex
client makes those queries live — the plumbing is done, it is simply unused.

It also subsumes the second half of plan 018's "deferred, deliberately" item 2: once the
playlist is server state, `savedArticles`'s `useState`-mirrors-`localStorage` problem
(`App.tsx:60`, re-read by hand at `:215`, `:222`, `:449`, `:462`) stops being a
`useSyncExternalStore` question and becomes a cache question with a different answer.
**Do not fix `savedArticles` separately first** — that is the competing design this plan
exists to prevent.

## Current state

```
client                                    Convex
  localStorage['kinetic_saved_articles_v2']  articles      (written only by tts.synthesize)
    keyed by  sourceUrl || title             userArticles  (never written by anyone)
    ▲                                        ▲
    └── getSavedArticles() ── useState        └── getUserPlaylist() ── nobody
```

The two halves cannot currently be joined, and that is the real blocker:

- `articles.extract` (`routers/articles.ts:305`) returns a parsed article and **persists
  nothing** — no document, no id.
- `tts.synthesize` **does** persist, via `getOrCreateArticleStub` (`routers/tts.ts:167`),
  but **never returns the `articleId`** — check all six return branches.
- `userArticles.articleId` is `v.id('articles')` (`schema.ts:107`), while the client's
  library is keyed by `sourceUrl || title` (`storage.ts:36`).

There is therefore no way, today, for the client to name an article the server would
recognise. Step 1 exists to fix that and everything else depends on it.

One more thing to carry forward: writes to `articles` are deliberately gated. The comment
at `routers/tts.ts:88` is explicit — without the rate limit "an attacker can grow the
`articles` table for free". Any new public mutation that inserts an article inherits that
requirement. It is not optional.

## Scope

**In scope**: returning an article id to the client, a public playlist-add mutation, reading
the playlist with `useQuery`, writing progress back, and the signed-out → signed-in merge.

**Out of scope**:

- Offline *write* queueing. Signed-out and offline both keep using `localStorage`; a
  proper outbox with conflict resolution is its own plan and this one must not grow one.
- Sharing (`/r/:id`) — plan 016, even though it also wants a durable article id. Coordinate:
  if 016 lands first, reuse whatever id it introduced rather than adding a second.
- The modal booleans and `settings` (plan 021), and URL state (plan 016).

## Steps

### Step 1: Let the client learn an article's id

Add `articleId` to `tts.synthesize`'s return type on every branch that has one — after
`:167` it always does. The early-return branches (rate-limited, no-key, over-cap) legitimately
have no article; type it `articleId?: Id<'articles'>` rather than inventing one.

Then thread it into the client: `ArticleData` (`apps/web/src/types.ts`) gains
`convexId?: string`, and `loadArticleContent` records it on the article it just loaded.

**Verify**: `bun run typecheck` clean; a synthesised article in the browser shows a
`convexId` in the object passed to `saveArticleToLibrary`.

### Step 2: A public, rate-limited `playlist.add`

Articles reach the library by two routes and only one of them synthesises: "Add to queue"
(`App.tsx:447-450`, `:460-463`) never calls TTS, so those articles have no Convex document
at all. A playlist that silently drops half of what the user adds is worse than no playlist.

Add to `routers/users.ts` (or a new `routers/playlist.ts` if that file is getting long):

```ts
export const addToPlaylist = mutation
  .input(z.object({
    url: z.string(),
    title: z.string(),
    author: z.string().optional(),
    content: z.string(),
  }))
  .mutation(async ({ ctx, input }) => { /* ... */ });
```

Three requirements, all non-negotiable:

1. **Auth first** — reuse `resolveAuthUser`; throw for anonymous callers exactly as
   `saveUserProgress:80` does.
2. **Rate limit before the write** — the same gate `tts.synthesize` uses
   (`lib/rateLimiter.ts:37`, consumed via `ttsInternal.consumeTtsRateLimit`). This is a
   public, authenticated, unbounded-`content` insert; without the limit it is the free
   table growth `tts.ts:88` warns about.
3. **Cap `content`** — mirror whatever `MAX_CONTENT_CHARS` `articles.ts` enforces. Do not
   pick a new number.

Reuse `getOrCreateArticleStub` for the upsert-by-url rather than writing a second one.

**Verify**: a `convex-test` case per requirement — anonymous caller throws; a caller over
the limit is rejected before any insert; oversized content is capped, not stored whole;
adding the same url twice yields one `articles` row and one `userArticles` row.

### Step 3: Fix the `articleId` validator while you are here

`saveUserProgress` (`:73`) and `deleteUserArticle` (`:117`) both take `articleId:
z.string()` and pass it straight into a field typed `v.id('articles')`. Convex catches this
at insert time, so it throws rather than corrupting anything — but it throws as an opaque
server error instead of a validation failure at the boundary. Use kitcn's id validator (see
`convex/functions/_generated/ai/guidelines.md`) so a bad id is rejected as input.

**Verify**: a test passing `'not-an-id'` gets a validation error, not a runtime one.

### Step 4: Read the playlist with `useQuery`

The first `useQuery` in the codebase. In `App.tsx`:

```tsx
const playlist = useQuery(crpc.routers.users.getUserPlaylist.queryOptions({}));
```

`getUserPlaylist` returns `[]` for anonymous callers (`users.ts:40`), which makes the
signed-out path fall out naturally rather than needing a conditional hook.

The library the drawer renders becomes **derived**, not stored:

```tsx
const savedArticles = user ? fromPlaylist(playlist.data ?? []) : localArticles;
```

Delete the `savedArticles` `useState` (`App.tsx:60`) and all four
`setSavedArticles` re-reads (`:215`, `:222`, `:449`, `:462`). Mutations
invalidate the query instead; TanStack Query plus Convex's live queries then push the update
to every open tab and device, which is the whole point.

`fromPlaylist` maps the server shape (`users.ts:52-61`) onto `SavedArticleItem` — write it
in `lib/storage.ts` next to the local shape so the two stay visibly in sync.

**Verify**: signed in, add an article in one tab and watch it appear in a second without a
refresh. `grep -c "setSavedArticles" apps/web/src/App.tsx` returns 0.

### Step 5: Write progress back

`userArticles` has four progress columns nobody writes. The engine already publishes exactly
what they need on every snapshot: `progress`, `currentWordIndex`, `currentTime`.

Call `saveUserProgress` on a **throttled** cadence — the snapshot changes up to 60 times a
second during playback (that was plan 018's Bug 2), so a naive effect on `playback.progress`
is a mutation per frame. Every ~10s of playback, plus on pause and on unmount, is enough.
Throttle it outside React (a timestamp in a ref, checked in the effect) rather than with a
`useEffect` dependency dance.

Only for signed-in users; anonymous playback keeps writing to `localStorage`.

**Verify**: read half an article, reload, and the position is restored from the server.
Count the mutations in the Convex dashboard for a 60s playback — it should be ~6, not ~3600.

### Step 6: Merge the local library on first sign-in

A user who has been reading signed-out has a `localStorage` library. On sign-in, upload it
once: for each local item, call `addToPlaylist`; mark the local store merged (a flag key
next to `kinreader_client_id`) so it does not re-upload on every subsequent sign-in.

Do this behind an explicit event — the sign-in success handler — not an effect that watches
`user` going from `null` to non-null. That effect fires on every page load for a signed-in
user, and the guard flag is then the only thing standing between you and re-uploading the
library forever. An event is the honest model of "the user just signed in" (§1: model
events, not state changes).

**Verify**: sign out, add two articles, sign in — both appear in the cloud playlist, and
signing out and in again does not duplicate them.

## Test plan

Backend (`convex-test`, alongside the existing `users.test.ts`):

- `addToPlaylist`: anonymous → throws; rate-limited → rejected before insert; oversize
  content → capped; same url twice → one row each in `articles` and `userArticles`.
- `saveUserProgress` with a malformed `articleId` → input validation error (Step 3).
- `getUserPlaylist` returns only the caller's rows — the 008 review already established
  this pattern; extend it to cover a row added via `addToPlaylist`.

Frontend (happy-dom):

- Signed out, the drawer renders the `localStorage` library and no query is issued.
- Signed in, the drawer renders the server playlist; a local-only article does not appear
  until merged.
- The progress writer fires once, not per frame, across a simulated 60s of snapshot churn.
  This is the regression that costs real money if it lands wrong.

## Done criteria

- [ ] `tts.synthesize` returns `articleId` on every branch that has one
- [ ] `addToPlaylist` exists, is authenticated, rate-limited, and content-capped
- [ ] `apps/web` contains at least one `useQuery`, and `grep -c "setSavedArticles"` returns 0
- [ ] A signed-in user's library and reading position appear on a second device
- [ ] Progress writes are throttled to ~1 per 10s of playback, verified by count
- [ ] The signed-out library merges exactly once on sign-in
- [ ] `bun run typecheck`, `bun run test`, `bun run build` clean

## STOP conditions

- **Step 1 cannot produce an id the client can hold** — e.g. `getOrCreateArticleStub`
  turns out to key on something unstable. Everything downstream depends on it; stop rather
  than inventing a second identifier scheme, and note that plan 016 needs the same id.
- **The rate limiter cannot be applied to `addToPlaylist`.** Do not ship the mutation
  without it. An authenticated free-insert into `articles` is the exact hole `tts.ts:88`
  documents.
- **The merge in Step 6 needs conflict resolution** (the same url exists locally with one
  progress and on the server with another). Stop and report — picking a winner silently
  loses someone's reading position, and the right answer is a product decision.
- The change starts rewriting `localStorage` into an offline write queue. Out of scope by
  construction; report and stop.

## Maintenance notes

- The rule: **the library is server state when signed in and local state when not.** One
  branch, taken once, at the top of the component — not per call site.
- `getUserPlaylist` returning `[]` rather than throwing for anonymous callers is what keeps
  that branch cheap. Preserve it.
- Every new public mutation that writes to `articles` needs the rate limit. There will be a
  third one eventually (plan 016); this plan is where the pattern gets set.
