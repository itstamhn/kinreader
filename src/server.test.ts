import { test, expect } from 'bun:test';
import { app, secureSixDigitCode } from './server';

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
