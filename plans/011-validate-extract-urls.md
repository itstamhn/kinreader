# Plan 011: Validate extraction URLs to close the SSRF

> **Executor instructions**: Follow step by step. Run every verification command. If a
> STOP condition occurs, stop and report — do not improvise.
>
> **Drift check**: `git diff --stat 7e478c5..HEAD -- convex/routers/articles.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/006` (DONE), and `plans/007` if it touches the same file
- **Category**: security
- **Planned at**: commit `7e478c5`, 2026-08-28

## Why this matters

The extract action takes a user-supplied URL and fetches it server-side with no
validation. Its input schema is `z.object({ url: z.string().min(1) })` — any string. It
then calls `fetch(url)` directly and **returns the response body to the caller**, which
makes it a readable SSRF, not just a blind one.

Plan 006 moved this from the Cloudflare Worker into a Convex action. That changed the
blast radius rather than removing it: requests now originate from Convex's network. The
endpoint is public and unauthenticated.

Concretely, an attacker can currently ask your backend to fetch `http://localhost:*`,
link-local metadata addresses like `169.254.169.254`, and RFC1918 ranges, and read back
whatever comes out.

## Current state

- `convex/routers/articles.ts` — the `extract` action. Verified at planning time: no
  `new URL`, no protocol check, no host check anywhere in the file.
- The fetch chain is: fxtwitter (only for matched X status URLs, safe — a fixed host),
  then Monid (fixed host), then **`fetch(url)` directly** (the dangerous one), then Jina
  Reader (fixed host, and it takes the URL as a path segment).
- Only the direct-HTML fallback needs guarding. The other three go to fixed, trusted
  hosts — but Jina still receives the raw URL, so validation must happen **before** any of
  them run, not just around the direct fetch.

## Scope

**In scope**: `convex/routers/articles.ts`, `convex/routers/articles.test.ts`.

**Out of scope**: the extraction logic itself (parsing, cleaning, fallback order), the
1MB truncation guard, and anything under `src/`. This plan adds a gate at the front; it
does not restructure what happens after the gate.

## Steps

### Step 1: Add a URL validator

Add a helper in `convex/routers/articles.ts` that runs **before** any fetch:

```ts
function assertPublicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }

  const host = parsed.hostname.toLowerCase();

  // Reject obvious local / private / link-local targets by name.
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('URL host is not permitted');
  }

  // Reject literal IPs in private, loopback, and link-local ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      throw new Error('URL host is not permitted');
    }
  }

  // IPv6 loopback / unique-local / link-local, including v4-mapped forms.
  if (host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::' || /^f[cd]/i.test(h) || /^fe80:/i.test(h) || h.includes('127.0.0.1')) {
      throw new Error('URL host is not permitted');
    }
  }

  return parsed;
}
```

Call it once at the top of the action, on the trimmed input, and use the returned
`parsed.toString()` downstream.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Return a clean error, not a throw

A rejected URL should surface to the client the way other extraction failures do —
consistent with how the action already reports problems — rather than as an unhandled
exception. Match the existing error style in the file.

**Verify**: `bun test` → all pass.

## Test plan

Extend `convex/routers/articles.test.ts` (import `api` from `convex/shared/api.ts`, not
`convex/_generated/api` — see the note already in that file). Stub `fetch` and assert it
is **never called** for a rejected URL — that is the actual security property:

- `http://localhost:3008/admin` → rejected, `fetch` not called
- `http://127.0.0.1/` → rejected, `fetch` not called
- `http://169.254.169.254/latest/meta-data/` → rejected, `fetch` not called
- `http://10.0.0.5/`, `http://192.168.1.1/`, `http://172.16.0.1/` → rejected
- `file:///etc/passwd` → rejected
- `javascript:alert(1)` → rejected
- `not-a-url` → rejected
- `https://example.com/article` → **accepted**, `fetch` called (the regression guard: the
  validator must not break normal extraction)
- `https://x.com/user/status/123` → accepted (the X path still works)

## Done criteria

- [ ] `bun run typecheck` exits 0; `bun test` passes including all rejection cases
- [ ] Every rejection test asserts `fetch` was not called
- [ ] The `https://example.com/article` acceptance test passes
- [ ] `bun run build` exits 0

## STOP conditions

- Adding validation breaks the X/Twitter extraction path. Report — that path must keep
  working.
- You conclude a DNS-resolution check is required to be correct. It would be more
  thorough, but it is out of scope here and has its own failure modes; report instead of
  building it.

## Maintenance notes

- **This is a hostname allow/deny check, not a full SSRF defence.** It does not resolve
  DNS, so a hostname that resolves to a private address (DNS rebinding) still passes. That
  is a known, accepted limitation of this plan. Closing it properly needs resolution-time
  validation or an egress proxy — worth planning separately if this endpoint ever handles
  untrusted traffic at scale.
- Redirects are also not followed-and-revalidated: `fetch` follows redirects by default,
  so a public URL can still redirect to a private one. Consider `redirect: 'manual'` with
  per-hop validation as the natural follow-up.
- A reviewer should check that validation happens **before** the Jina fallback, which also
  receives the raw URL.
