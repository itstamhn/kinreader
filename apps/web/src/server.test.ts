import { test, expect } from 'bun:test';
import { app, secureSixDigitCode, canonicalOrigin, readCookie, OAUTH_STATE_COOKIE } from './server';

test('GET /api/health returns 200 with status ok', async () => {
  const res = await app.handle(new Request('http://localhost/api/health'));

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.status).toBe('ok');
  expect(typeof data.timestamp).toBe('string');
});

// Extraction moved to a Convex action (convex/routers/articles.ts, plan 006).
// The route is gone from this Spiceflow app entirely -- see
// convex/routers/articles.test.ts for the "missing url" coverage that used
// to live here.
test('POST /api/extract no longer exists on the Spiceflow app (404, not 400)', async () => {
  const res = await app.handle(
    new Request('http://localhost/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  );

  expect(res.status).toBe(404);
});

// TTS generation moved to a Convex action (convex/routers/tts.ts, plan 007),
// including the rate limiting and 4000-char cap that used to live here --
// see convex/routers/tts.test.ts for that coverage.
test('POST /api/tts no longer exists on the Spiceflow app (404, not 400)', async () => {
  const res = await app.handle(
    new Request('http://localhost/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  );

  expect(res.status).toBe(404);
});

// Guard against plan 006's exact bug class recurring: a route was removed
// from src/server.ts (above), but a client call site was missed and
// silently 404'd because nothing checked for stragglers. This scans every
// .ts/.tsx file under src/ and fails if any of them still mentions a dead
// route, aside from this file's own assertions above.
test('no file under src/ references api/extract or api/tts except this file\'s own 404 assertions', async () => {
  const glob = new Bun.Glob('**/*.{ts,tsx}');
  const offenders: string[] = [];

  for await (const relPath of glob.scan({ cwd: import.meta.dir })) {
    if (relPath === 'server.test.ts') continue; // this file -- permitted, see above
    const text = await Bun.file(`${import.meta.dir}/${relPath}`).text();
    if (text.includes('api/extract') || text.includes('api/tts')) {
      offenders.push(relPath);
    }
  }

  expect(offenders).toEqual([]);
});

test('GET /r/:id escapes a </title><script> payload in the t param', async () => {
  const res = await app.handle(
    new Request('http://localhost/r/x?t=%3C/title%3E%3Cscript%3Ealert(1)%3C/script%3E')
  );

  const body = await res.text();
  expect(body).not.toContain('<script>');
  expect(body).toContain('&lt;script&gt;');
});

test('GET /r/:id escapes an attribute-breaking payload in the a param', async () => {
  const res = await app.handle(
    new Request('http://localhost/r/x?a=%22%3E%3Cscript%3Ealert(1)%3C/script%3E')
  );

  const body = await res.text();
  expect(body).not.toContain('"><script>');
  expect(body).toContain('&quot;&gt;&lt;script&gt;');
});

test('GET /r/:id renders an ordinary title as readable text', async () => {
  const res = await app.handle(new Request('http://localhost/r/x?t=Hello%20World'));

  const body = await res.text();
  expect(body).toContain('Hello World');
});

test('GET /r/:id escapes an apostrophe in the title', async () => {
  const res = await app.handle(new Request("http://localhost/r/x?t=Dan's%20Article"));

  const body = await res.text();
  expect(body).toContain('Dan&#39;s Article');
});

test('GET /api/og escapes a <script> payload in the title param', async () => {
  const res = await app.handle(
    new Request('http://localhost/api/og?title=%3Cscript%3Ealert(1)%3C/script%3E')
  );

  const body = await res.text();
  expect(body).not.toContain('<script>');
  expect(body).toContain('&lt;script&gt;');
});

test('GET /api/og rejects a javascript: image URL', async () => {
  const res = await app.handle(
    new Request('http://localhost/api/og?image=javascript:alert(1)')
  );

  const body = await res.text();
  expect(body).not.toContain('javascript:');
});

test('GET /api/og allows a legitimate https image URL through as an href', async () => {
  const res = await app.handle(
    new Request('http://localhost/api/og?image=https://example.com/a.png')
  );

  const body = await res.text();
  expect(body).toContain('href="https://example.com/a.png"');
});

// --- Server-side token verification against KV-backed auth store (plan 003) ---

function createKvStub() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => (store.has(key) ? store.get(key)! : null),
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function verifyRequest(body: Record<string, unknown>, env: any): Request {
  const request = new Request('http://localhost/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  (request as any).env = env;
  return request;
}

test('POST /api/auth/verify with a token that was never issued returns 400 and no user', async () => {
  const kv = createKvStub();
  const env = { AUTH_CODES: kv };

  const res = await app.handle(
    verifyRequest({ email: 'nobody@example.com', token: 'forged' }, env)
  );

  expect(res.status).toBe(400);
  const data = await res.json();
  expect(data.user).toBeUndefined();
});

test('POST /api/auth/verify with an expired record returns 400', async () => {
  const kv = createKvStub();
  const email = 'expired@example.com';
  await kv.put(
    `auth:${email}`,
    JSON.stringify({ code: '123456', token: 'expired-token', expires: Date.now() - 1000 })
  );
  const env = { AUTH_CODES: kv };

  const res = await app.handle(verifyRequest({ email, token: 'expired-token' }, env));

  expect(res.status).toBe(400);
  const data = await res.json();
  expect(data.user).toBeUndefined();
});

test('POST /api/auth/verify with the correct token returns 200 and success: true', async () => {
  const kv = createKvStub();
  const email = 'valid@example.com';
  await kv.put(
    `auth:${email}`,
    JSON.stringify({ code: '123456', token: 'correct-token', expires: Date.now() + 60_000 })
  );
  const env = { AUTH_CODES: kv };

  const res = await app.handle(verifyRequest({ email, token: 'correct-token' }, env));

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.success).toBe(true);
  expect(data.user.email).toBe(email);
});

test('POST /api/auth/verify tokens are single-use: a second verify with the same token returns 400', async () => {
  const kv = createKvStub();
  const email = 'single-use@example.com';
  await kv.put(
    `auth:${email}`,
    JSON.stringify({ code: '123456', token: 'one-shot-token', expires: Date.now() + 60_000 })
  );
  const env = { AUTH_CODES: kv };

  const firstRes = await app.handle(verifyRequest({ email, token: 'one-shot-token' }, env));
  expect(firstRes.status).toBe(200);
  const firstData = await firstRes.json();
  expect(firstData.success).toBe(true);

  const secondRes = await app.handle(verifyRequest({ email, token: 'one-shot-token' }, env));
  expect(secondRes.status).toBe(400);
  const secondData = await secondRes.json();
  expect(secondData.user).toBeUndefined();
});

// --- Attempt limiting on /api/auth/verify (plan 010) ---

test('POST /api/auth/verify a wrong code increments attempts without deleting the record, and a subsequent correct code still succeeds', async () => {
  const kv = createKvStub();
  const email = 'typo@example.com';
  await kv.put(
    `auth:${email}`,
    JSON.stringify({ code: '654321', token: 'typo-token', expires: Date.now() + 60_000, attempts: 0 })
  );
  const env = { AUTH_CODES: kv };

  const wrongRes = await app.handle(verifyRequest({ email, code: '000000' }, env));
  expect(wrongRes.status).toBe(400);

  const stored = JSON.parse(kv.store.get(`auth:${email}`)!);
  expect(stored.attempts).toBe(1);

  // A legitimate user mistyping once must still succeed on their next try.
  const correctRes = await app.handle(verifyRequest({ email, code: '654321' }, env));
  expect(correctRes.status).toBe(200);
  const correctData = await correctRes.json();
  expect(correctData.success).toBe(true);
});

test('POST /api/auth/verify five wrong attempts burn the code: a subsequent correct code then fails', async () => {
  const kv = createKvStub();
  const email = 'bruteforce@example.com';
  const correctCode = '111222';
  await kv.put(
    `auth:${email}`,
    JSON.stringify({ code: correctCode, token: 'bf-token', expires: Date.now() + 60_000, attempts: 0 })
  );
  const env = { AUTH_CODES: kv };

  for (let i = 0; i < 5; i++) {
    const res = await app.handle(verifyRequest({ email, code: '000000' }, env));
    expect(res.status).toBe(400);
  }

  // The record must be gone after the 5th wrong attempt.
  expect(kv.store.has(`auth:${email}`)).toBe(false);

  // The correct code must now fail too -- the code was burned, not just the
  // wrong guesses rejected.
  const finalRes = await app.handle(verifyRequest({ email, code: correctCode }, env));
  expect(finalRes.status).toBe(400);
  const finalData = await finalRes.json();
  expect(finalData.user).toBeUndefined();
});

test('POST /api/auth/verify error body is byte-identical for unknown email, wrong code, and expired record (no enumeration oracle)', async () => {
  const kv = createKvStub();
  const env = { AUTH_CODES: kv };

  const unknownRes = await app.handle(
    verifyRequest({ email: 'never-signed-up@example.com', code: '123456' }, env)
  );
  const unknownBody = await unknownRes.text();

  const wrongEmail = 'wrong-code-oracle@example.com';
  await kv.put(
    `auth:${wrongEmail}`,
    JSON.stringify({ code: '999999', token: 'tok', expires: Date.now() + 60_000, attempts: 0 })
  );
  const wrongRes = await app.handle(verifyRequest({ email: wrongEmail, code: '000000' }, env));
  const wrongBody = await wrongRes.text();

  const expiredEmail = 'expired-oracle@example.com';
  await kv.put(
    `auth:${expiredEmail}`,
    JSON.stringify({ code: '999999', token: 'tok', expires: Date.now() - 1000, attempts: 0 })
  );
  const expiredRes = await app.handle(verifyRequest({ email: expiredEmail, code: '000000' }, env));
  const expiredBody = await expiredRes.text();

  expect(unknownRes.status).toBe(400);
  expect(wrongRes.status).toBe(400);
  expect(expiredRes.status).toBe(400);
  expect(unknownBody).toBe(wrongBody);
  expect(wrongBody).toBe(expiredBody);
});

test('POST /api/auth/verify a denied rate limiter returns 429 with Retry-After: 60', async () => {
  const kv = createKvStub();
  const env = {
    AUTH_CODES: kv,
    AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
  };

  const res = await app.handle(verifyRequest({ email: 'anyone@example.com', code: '123456' }, env));

  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('60');
});

test('secureSixDigitCode: 10,000 codes are all in range and mostly distinct', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const code = secureSixDigitCode();
    expect(code.length).toBe(6);
    const num = Number(code);
    expect(num).toBeGreaterThanOrEqual(100000);
    expect(num).toBeLessThanOrEqual(999999);
    codes.add(code);
  }

  expect(codes.size).toBeGreaterThanOrEqual(9000);
});

// --- Google OAuth: the mobile sign-in failures (redirect_uri, state, errors) ---

function googleRequest(url: string, env: any, headers: Record<string, string> = {}): Request {
  const request = new Request(url, { headers });
  (request as any).env = env;
  return request;
}

function locationOf(res: Response): URL {
  return new URL(res.headers.get('Location') || '', 'http://localhost');
}

const GOOGLE_ENV = {
  APP_ORIGIN: 'https://kinreader.com',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
};

// The redirect_uri used to be built from the incoming request's origin, so a
// visitor on www., on *.workers.dev, or on a preview URL sent Google a URI it
// had never been told about and got a 400 redirect_uri_mismatch instead of a
// consent screen.
test('GET /api/auth/google sends Google the canonical redirect_uri, whatever host the user arrived on', async () => {
  const res = await app.handle(
    googleRequest('https://www.kinreader.com/api/auth/google', GOOGLE_ENV)
  );

  // First hop: onto the canonical origin, so the state cookie lands on the
  // host that will receive the callback.
  expect(res.status).toBe(302);
  expect(res.headers.get('Location')).toBe('https://kinreader.com/api/auth/google?canonical=1');

  const second = await app.handle(
    googleRequest('https://kinreader.com/api/auth/google', GOOGLE_ENV)
  );
  const google = locationOf(second);
  expect(google.origin).toBe('https://accounts.google.com');
  expect(google.searchParams.get('redirect_uri')).toBe(
    'https://kinreader.com/api/auth/google/callback'
  );
});

test('GET /api/auth/google issues a state parameter matched by an HttpOnly SameSite=Lax cookie', async () => {
  const res = await app.handle(
    googleRequest('https://kinreader.com/api/auth/google', GOOGLE_ENV)
  );

  const state = locationOf(res).searchParams.get('state');
  expect(typeof state).toBe('string');
  expect(state!.length).toBeGreaterThan(10);

  const cookie = res.headers.get('Set-Cookie') || '';
  expect(cookie).toContain(`kr_oauth_state=${state}`);
  expect(cookie).toContain('HttpOnly');
  // Strict would be withheld on Google's redirect back and break every login.
  expect(cookie).toContain('SameSite=Lax');
  expect(cookie).toContain('Secure');
});

test('GET /api/auth/google with no client id configured redirects home with a readable auth_error', async () => {
  const res = await app.handle(
    googleRequest('https://kinreader.com/api/auth/google', { APP_ORIGIN: 'https://kinreader.com' })
  );

  expect(res.status).toBe(302);
  const location = locationOf(res);
  expect(location.origin).toBe('https://kinreader.com');
  expect(location.searchParams.get('auth_error')).toContain('not configured');
});

test('GET /api/auth/google/callback rejects a callback whose state does not match the cookie', async () => {
  const kv = createKvStub();
  const res = await app.handle(
    googleRequest(
      'https://kinreader.com/api/auth/google/callback?code=abc&state=attacker-state',
      { ...GOOGLE_ENV, AUTH_CODES: kv },
      { Cookie: 'kr_oauth_state=real-state' }
    )
  );

  expect(res.status).toBe(302);
  expect(locationOf(res).searchParams.get('auth_error')).toBeTruthy();
  // Nothing was signed in on the way past.
  expect(kv.store.size).toBe(0);
});

test('GET /api/auth/google/callback rejects a callback with no state cookie at all', async () => {
  const kv = createKvStub();
  const res = await app.handle(
    googleRequest('https://kinreader.com/api/auth/google/callback?code=abc&state=anything', {
      ...GOOGLE_ENV,
      AUTH_CODES: kv,
    })
  );

  expect(locationOf(res).searchParams.get('auth_error')).toBeTruthy();
  expect(kv.store.size).toBe(0);
});

test('GET /api/auth/google/callback reports a cancelled consent screen instead of "Missing Google credentials"', async () => {
  const res = await app.handle(
    googleRequest(
      'https://kinreader.com/api/auth/google/callback?error=access_denied&state=s',
      GOOGLE_ENV,
      { Cookie: 'kr_oauth_state=s' }
    )
  );

  expect(locationOf(res).searchParams.get('auth_error')).toBe('Google sign-in was cancelled');
});

test('GET /api/auth/google/callback signs in a verified Google account and hands back a real token', async () => {
  const kv = createKvStub();
  const realFetch = global.fetch;
  global.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'google-access-token' }), { status: 200 });
    }
    if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
      return new Response(
        JSON.stringify({ email: 'Reader@Example.com', email_verified: true, name: 'Reader' }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as any;

  try {
    const res = await app.handle(
      googleRequest(
        'https://kinreader.com/api/auth/google/callback?code=abc&state=s',
        { ...GOOGLE_ENV, AUTH_CODES: kv },
        { Cookie: 'kr_oauth_state=s' }
      )
    );

    const location = locationOf(res);
    expect(location.origin).toBe('https://kinreader.com');
    expect(location.searchParams.get('email')).toBe('reader@example.com');
    const token = location.searchParams.get('auth_token');
    expect(typeof token).toBe('string');

    // The token the browser was handed is the one the store will accept.
    const record = JSON.parse(kv.store.get('auth:reader@example.com')!);
    expect(record.token).toBe(token);
    // The one-shot state cookie is spent.
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  } finally {
    global.fetch = realFetch;
  }
});

// A userinfo response with no email used to write a record under
// `auth:undefined` and send the browser to `?email=undefined`, which then
// failed verification with nothing shown to the user.
test('GET /api/auth/google/callback refuses a Google profile with no email instead of writing auth:undefined', async () => {
  const kv = createKvStub();
  const realFetch = global.fetch;
  global.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'google-access-token' }), { status: 200 });
    }
    return new Response(JSON.stringify({ name: 'No Email' }), { status: 200 });
  }) as any;

  try {
    const res = await app.handle(
      googleRequest(
        'https://kinreader.com/api/auth/google/callback?code=abc&state=s',
        { ...GOOGLE_ENV, AUTH_CODES: kv },
        { Cookie: 'kr_oauth_state=s' }
      )
    );

    const location = locationOf(res);
    expect(location.searchParams.get('auth_token')).toBeNull();
    expect(location.searchParams.get('auth_error')).toContain('email address');
    expect(kv.store.size).toBe(0);
  } finally {
    global.fetch = realFetch;
  }
});

test('GET /api/auth/google/callback refuses an unverified Google email', async () => {
  const kv = createKvStub();
  const realFetch = global.fetch;
  global.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'google-access-token' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ email: 'unverified@example.com', email_verified: false }),
      { status: 200 }
    );
  }) as any;

  try {
    const res = await app.handle(
      googleRequest(
        'https://kinreader.com/api/auth/google/callback?code=abc&state=s',
        { ...GOOGLE_ENV, AUTH_CODES: kv },
        { Cookie: 'kr_oauth_state=s' }
      )
    );

    expect(locationOf(res).searchParams.get('auth_error')).toContain('not verified');
    expect(kv.store.size).toBe(0);
  } finally {
    global.fetch = realFetch;
  }
});

test('canonicalOrigin keeps localhost on its own origin so local dev still works', () => {
  expect(canonicalOrigin({}, new Request('http://localhost:3000/api/auth/google'))).toBe(
    'http://localhost:3000'
  );
  // An unconfigured production origin still gets a stable, registerable URI.
  expect(canonicalOrigin({}, new Request('https://kinetic-reader.workers.dev/api/auth/google'))).toBe(
    'https://kinreader.com'
  );
  expect(
    canonicalOrigin({ APP_ORIGIN: 'https://staging.kinreader.com/' }, new Request('https://x.dev/'))
  ).toBe('https://staging.kinreader.com');
});

test('readCookie picks its cookie out of a crowded header and ignores lookalikes', () => {
  const header = `theme=dark; not_${OAUTH_STATE_COOKIE}=decoy; ${OAUTH_STATE_COOKIE}=abc123; other=1`;

  expect(readCookie(header, OAUTH_STATE_COOKIE)).toBe('abc123');
  expect(readCookie(header, 'missing')).toBeNull();
  expect(readCookie(null, OAUTH_STATE_COOKIE)).toBeNull();
  expect(readCookie('', OAUTH_STATE_COOKIE)).toBeNull();
});

// A dev proxy that rewrites `Host` (Vite's `changeOrigin: true`) makes the
// canonical-origin bounce look permanently necessary; without the one-hop cap
// the browser would ping-pong forever instead of reaching Google.
test('GET /api/auth/google bounces to the canonical origin at most once', async () => {
  const res = await app.handle(
    googleRequest('http://localhost:3008/api/auth/google?canonical=1', {
      ...GOOGLE_ENV,
      APP_ORIGIN: 'http://localhost:3000',
    })
  );

  const location = locationOf(res);
  expect(location.origin).toBe('https://accounts.google.com');
  expect(location.searchParams.get('redirect_uri')).toBe(
    'http://localhost:3000/api/auth/google/callback'
  );
});
