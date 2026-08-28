# Plan 003: Stop trusting the URL — verify every auth token server-side against durable storage

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2477929..HEAD -- src/App.tsx src/server.ts src/components/AuthModal.tsx wrangler.jsonc`
> If any of those changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-establish-verification-baseline.md`
- **Category**: security
- **Planned at**: commit `2477929`, 2026-08-28

## Why this matters

The app signs a user in based on **query-string parameters alone**. `src/App.tsx:317-336`
reads `auth_token` and `email` from `window.location.search` and writes a `UserProfile`
with `tier: 'pro'` straight into React state and `localStorage`. The token is never sent
anywhere. Nothing checks it.

That means `https://kinreader.com/?auth_token=anything&email=someone@example.com` is a
complete, one-click sign-in as that person. No email access required, no code required.
The `/api/auth/verify` endpoint that *would* have checked the token exists at
`src/server.ts:71` and is simply never called on this path — `AuthModal.tsx` calls it for
manually-typed 6-digit codes, but the magic-link and Google redirect flows bypass it.

There is a second defect that makes a naive fix unsafe to ship. The token store is a
module-scope `Map` (`src/server.ts:6`). Cloudflare Workers isolates are ephemeral and
per-colo, so a token minted in one isolate is frequently absent from the isolate that
handles the verify call. If you route the client through `/api/auth/verify` while the
store is still in-memory, you convert a security hole into an intermittent
"Invalid or expired verification code" for legitimate users — and the pressure will be
to revert. So this plan moves the store to Workers KV in the same change. Both parts are
required; shipping either alone leaves the app either insecure or broken.

## Current state

- `src/App.tsx:317-336` — the `useEffect` that trusts the URL. This is the vulnerability.
- `src/server.ts:6` — `authCodes`, the in-memory store.
- `src/server.ts:16` — `POST /api/auth/magic-link`, mints code + token, writes to the Map.
- `src/server.ts:71` — `POST /api/auth/verify`, reads the Map. Correct logic, never
  reached by the magic-link redirect.
- `src/server.ts:145` — `GET /api/auth/google/callback`, writes to the Map, then
  redirects with the same trusted-URL pattern.
- `src/components/AuthModal.tsx:67` — the one existing caller of `/api/auth/verify`.
- `wrangler.jsonc` — no `kv_namespaces` block yet.

The vulnerable block exactly as it exists today:

```tsx
// src/App.tsx:316-337
  // Check URL on mount for auth token
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get('auth_token');
      const email = urlParams.get('email');
      const name = urlParams.get('name');
      const avatar = urlParams.get('avatar');

      if (token && email) {
        const newUser: UserProfile = {
          email,
          name: name ? decodeURIComponent(name) : email.split('@')[0],
          avatar: avatar ? decodeURIComponent(avatar) : `https://unavatar.io/${encodeURIComponent(email)}`,
          tier: 'pro',
        };
        setUser(newUser);
        localStorage.setItem('kinreader_user', JSON.stringify(newUser));
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  }, []);
```

Note what it does: it takes `name`, `avatar` and `tier` from the **URL**, not from the
server. Even after adding verification, those fields must come from the server response.

The store and the endpoint that already does the right check:

```ts
// src/server.ts:6
const authCodes = new Map<string, { code: string; token: string; expires: number }>();
```

```ts
// src/server.ts:85-99
      const record = authCodes.get(email);
      if (!record || Date.now() > record.expires) {
        return new Response(JSON.stringify({ error: 'Invalid or expired verification code' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const isValid = (code && record.code === code) || (token && record.token === token);
      if (!isValid) {
        return new Response(JSON.stringify({ error: 'Incorrect verification code' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
```

Repo conventions that apply here:

- Worker bindings reach route handlers via `(request as any).env`, set once in
  `src/worker.ts:38`. Every handler reads them with this line — match it exactly:
  ```ts
  const env = ((request as any).env || (typeof process !== 'undefined' ? process.env : {})) || {};
  ```
- Error responses are `new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } })`.
  Success responses are returned as plain objects. See `src/server.ts:78-83` and
  `src/server.ts:105-113`.
- Config is `wrangler.jsonc` (JSONC, comments allowed), not `wrangler.toml`.

Workers KV facts you will need (from Cloudflare's current docs — do not guess the API):

- Create a namespace: `bunx wrangler kv namespace create AUTH_CODES` — it prints the id.
- Bind it in `wrangler.jsonc` as `"kv_namespaces": [{ "binding": "AUTH_CODES", "id": "<id>" }]`.
- `await env.AUTH_CODES.put(key, value, { expirationTtl: 900 })` — `expirationTtl` is in
  seconds and its **minimum is 60**. 900 = the 15 minutes this flow already uses.
- `await env.AUTH_CODES.get(key)` returns `string | null`.
- `await env.AUTH_CODES.delete(key)`.

## Commands you will need

| Purpose       | Command                                    | Expected on success   |
|---------------|--------------------------------------------|-----------------------|
| Install       | `bun install`                              | exit 0                |
| Typecheck     | `bun run typecheck`                        | exit 0, no output     |
| Tests         | `bun test`                                 | all pass              |
| Build         | `bun run build`                            | exit 0                |
| Create KV ns  | `bunx wrangler kv namespace create AUTH_CODES` | prints a namespace id |

`typecheck` and `test` exist only after plan 002. If they are missing, STOP.

## Scope

**In scope**:
- `src/App.tsx` (the `useEffect` at 316-337 only)
- `src/server.ts` (the auth store and the three auth routes)
- `wrangler.jsonc` (add the KV binding)
- `src/server.test.ts` (extend — created by plan 002)
- `src/App.test.tsx` (create)

**Out of scope** (do NOT touch, even though they look related):
- `src/components/AuthModal.tsx` — its `/api/auth/verify` call at line 67 already does
  the right thing and keeps working unchanged. Do not refactor it.
- The 6-digit code generation at `src/server.ts:38` (`Math.random()`) and the absence of
  attempt-limiting on verify. Both are real findings, both are separately planned work.
  Changing them here makes this diff unreviewable.
- `convex/routers/users.ts` — it has its own auth defects and is not imported by `src/`.
  A separate plan covers it.
- `/api/tts` rate limiting — that is plan 005. Do not gate TTS on auth here.
- The `tier: 'pro'` default. Whether every user should be 'pro' is a product decision,
  not a security fix. Keep returning what the server already returns.

## Git workflow

- Branch: `advisor/003-verify-auth-token-server-side`
- Conventional Commits. Suggested: `fix(auth): verify magic-link token server-side`
  and `fix(auth): move auth codes to Workers KV`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create and bind the KV namespace

```bash
bunx wrangler kv namespace create AUTH_CODES
```

Add the printed id to `wrangler.jsonc`, as a sibling of the existing `"assets"` key:

```jsonc
  "kv_namespaces": [
    { "binding": "AUTH_CODES", "id": "<id printed by the command above>" }
  ],
```

**Verify**: `bunx wrangler kv namespace list` → includes a namespace whose title
contains `AUTH_CODES`.

**Verify**: `grep -c "AUTH_CODES" wrangler.jsonc` → `1`.

If the account is not authenticated with `wrangler`, that is a STOP condition — do not
invent an id.

### Step 2: Replace the in-memory Map with a KV-backed store

In `src/server.ts`, delete the `authCodes` Map on line 6 and replace it with three
helpers that take the `env` object the handlers already build. Keep the record shape
identical so the verify logic at 85-99 barely changes:

```ts
type AuthRecord = { code: string; token: string; expires: number };

const AUTH_TTL_SECONDS = 15 * 60;

async function putAuthRecord(env: any, email: string, record: AuthRecord): Promise<void> {
  if (!env.AUTH_CODES) throw new Error('AUTH_CODES KV namespace is not bound');
  await env.AUTH_CODES.put(`auth:${email}`, JSON.stringify(record), {
    expirationTtl: AUTH_TTL_SECONDS,
  });
}

async function getAuthRecord(env: any, email: string): Promise<AuthRecord | null> {
  if (!env.AUTH_CODES) return null;
  const raw = await env.AUTH_CODES.get(`auth:${email}`);
  return raw ? (JSON.parse(raw) as AuthRecord) : null;
}

async function deleteAuthRecord(env: any, email: string): Promise<void> {
  if (!env.AUTH_CODES) return;
  await env.AUTH_CODES.delete(`auth:${email}`);
}
```

Update the three call sites to `await` these instead of touching the Map:
- `src/server.ts:42` (magic-link) — `authCodes.set(...)` → `await putAuthRecord(env, email, {...})`
- `src/server.ts:85` (verify) — `authCodes.get(email)` → `await getAuthRecord(env, email)`
- `src/server.ts:102` (verify) — `authCodes.delete(email)` → `await deleteAuthRecord(env, email)`
- `src/server.ts:196` (Google callback) — `authCodes.set(...)` → `await putAuthRecord(env, email, {...})`

The Google callback handler does not currently build an `env` local before line 196 —
add the standard line from "Current state" conventions.

Keep the `expires` field in the record. KV TTL and the explicit timestamp check are
belt-and-braces: KV expiry is eventually consistent, the timestamp is exact.

**Verify**: `grep -c "authCodes" src/server.ts` → `0`.

**Verify**: `bun run typecheck` → exit 0, no output.

### Step 3: Make `/api/auth/verify` the only way to become signed in

Rewrite the `useEffect` at `src/App.tsx:316-337`. It must POST the token to
`/api/auth/verify` and take **the user object from the server response** — never from
the URL:

```tsx
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('auth_token');
    const email = urlParams.get('email');
    if (!token || !email) return;

    // Strip the credentials from the address bar before any await.
    window.history.replaceState({}, document.title, window.location.pathname);

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, token }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data?.success || !data.user) return;
        setUser(data.user);
        localStorage.setItem('kinreader_user', JSON.stringify(data.user));
      } catch {
        // Verification failed — stay signed out.
      }
    })();

    return () => { cancelled = true; };
  }, []);
```

Three properties this must have, and a reviewer will check each:

1. `name`, `avatar` and `tier` come from `data.user`, **not** from `urlParams`.
2. On any failure — non-2xx, network error, `success: false` — the user stays signed
   out. There is no fallback that signs them in anyway.
3. `replaceState` runs before the `await`, so the token is out of the address bar and
   out of any subsequent `Referer` header even if verification is slow.

Delete the now-unused `name` and `avatar` reads from `urlParams` if nothing else uses
them.

**Verify**: `grep -n "tier: 'pro'" src/App.tsx` → **no output**. The client no longer
assigns a tier at all.

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Return the profile fields the client now depends on

`/api/auth/verify` at `src/server.ts:105-113` returns `email`, `name`, `avatar`, `tier`
— but derives `name` from the email local-part and ignores the Google display name and
picture captured at `src/server.ts:196`.

Extend `AuthRecord` with optional `name?: string` and `avatar?: string`, populate them
in the Google callback from `googleUser.name` / `googleUser.picture`, and prefer them in
the verify response when present:

```ts
        user: {
          email,
          name: record.name || username.charAt(0).toUpperCase() + username.slice(1),
          avatar: record.avatar || `https://unavatar.io/${encodeURIComponent(email)}`,
          tier: 'pro',
        },
```

The Google callback can then stop putting `name` and `avatar` in the redirect URL
entirely — they are no longer read by the client.

**Verify**: `bun run typecheck` → exit 0.

### Step 5: Prove the bypass is closed

Extend `src/server.test.ts` and create `src/App.test.tsx` per the test plan below.

**Verify**: `bun test` → all pass.

## Test plan

Extend `src/server.test.ts` (created by plan 002). These need a KV stub — a small
in-test object with `get`/`put`/`delete` backed by a `Map`, attached as
`(request as any).env = { AUTH_CODES: stub }`:

- `/api/auth/verify` with a token that was never issued → 400, and the body has no
  `user` field.
- `/api/auth/verify` with a token whose record has `expires` in the past → 400.
- `/api/auth/verify` with the correct token → 200 and `success: true`.
- After a successful verify, a **second** verify with the same token → 400 (the record
  was deleted; tokens are single-use).

Create `src/App.test.tsx` — the regression test for the actual vulnerability:

- Render `App` with `window.history.replaceState` pointing at
  `/?auth_token=forged&email=victim@example.com`, with `fetch` mocked to return
  `{ ok: false }`. Assert that after the effect settles, `localStorage.getItem('kinreader_user')`
  is `null` and no signed-in UI is shown. **Before this plan's change that assertion
  fails** — the user is signed in as `victim@example.com`. That is the test that proves
  the fix.
- Render with `fetch` mocked to return a valid `{ success: true, user: {...} }` and
  assert the user from the **response body** is stored — specifically, that a `name`
  supplied in the URL is ignored in favour of the one from the response.

Model the file structure on `src/components/LibraryDrawer.test.tsx` from plan 002.

Verification: `bun test` → all pass, including at least 4 new server cases and 2 new
App cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0 with no output
- [ ] `bun test` exits 0; the forged-token test in `src/App.test.tsx` passes
- [ ] `grep -c "authCodes" src/server.ts` returns `0`
- [ ] `grep -c "tier: 'pro'" src/App.tsx` returns `0`
- [ ] `grep -c "AUTH_CODES" wrangler.jsonc` returns `1`
- [ ] `grep -n "auth_token" src/App.tsx` shows the value being read and sent to
      `/api/auth/verify`, and **not** used to construct a `UserProfile`
- [ ] `bun run build` exits 0
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `bun run typecheck` or `bun test` does not exist — plan 002 has not landed. Do not
  proceed; these changes need the gate.
- `bunx wrangler kv namespace create` fails because the account is not authenticated.
  Report it. **Do not fabricate a namespace id** and do not fall back to keeping the
  in-memory Map "for now" — that combination is the failure mode this plan exists to
  prevent.
- `src/App.tsx:316-337` no longer matches the excerpt in "Current state" — someone else
  may have already changed this flow.
- You conclude the client needs to keep *any* field from the URL other than `email` and
  `auth_token` (both of which are only forwarded to the server for checking). Report
  which field and why.
- Verification works locally but you cannot confirm the KV binding resolves under
  `wrangler dev`. Report it rather than adding an in-memory fallback path — a fallback
  reintroduces the bypass whenever the binding is missing.

## Maintenance notes

- This plan closes the bypass **and** fixes the ephemeral-isolate token store, which was
  a separate audit finding. Both were folded together because fixing only the first
  makes login intermittently fail in production.
- Two related auth weaknesses are explicitly **not** fixed here and remain open: the
  6-digit code comes from `Math.random()` (`src/server.ts:38`) rather than a CSPRNG, and
  `/api/auth/verify` has no attempt limiting, so that code is brute-forceable. Plan
  those next; this change does not make them worse.
- A reviewer should check exactly one thing above all: that no code path in
  `src/App.tsx` writes to `localStorage` or calls `setUser` without a 2xx response from
  `/api/auth/verify`.
- If a session concept is added later, the `sessions` table already modelled in
  `convex/schema.ts:69` is the natural home — it is currently unused.
- Whoever adds a second Worker environment must create a KV namespace per environment;
  a missing binding now throws on sign-in rather than silently degrading, which is
  intentional.
