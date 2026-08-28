import { test, expect } from 'bun:test';
import { app } from './server';

test('GET /api/health returns 200 with status ok', async () => {
  const res = await app.handle(new Request('http://localhost/api/health'));

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.status).toBe('ok');
  expect(typeof data.timestamp).toBe('string');
});

test('POST /api/tts with an empty body returns 400', async () => {
  const res = await app.handle(
    new Request('http://localhost/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  );

  expect(res.status).toBe(400);
  const data = await res.json();
  expect(data.error).toBe('Text is required');
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

// --- Rate limiting / size cap on POST /api/tts (plan 005) ---

function ttsRequest(body: Record<string, unknown>, env?: any, headers?: Record<string, string>): Request {
  const request = new Request('http://localhost/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (env !== undefined) {
    (request as any).env = env;
  }
  return request;
}

test('POST /api/tts with text over 4000 chars returns 413', async () => {
  const res = await app.handle(ttsRequest({ text: 'a'.repeat(5000) }));

  expect(res.status).toBe(413);
  const data = await res.json();
  expect(typeof data.error).toBe('string');
});

test('POST /api/tts with text at exactly 4000 chars is not rejected as oversized', async () => {
  const res = await app.handle(ttsRequest({ text: 'a'.repeat(4000) }));

  expect(res.status).not.toBe(413);
});

test('POST /api/tts returns 429 with Retry-After when the limiter denies a paid request', async () => {
  const env = {
    SONIOX_API_KEY: 'fake-soniox-key',
    TTS_RATE_LIMITER: { limit: async () => ({ success: false }) },
  };
  const res = await app.handle(
    ttsRequest({ text: 'hello world', provider: 'soniox' }, env, { 'cf-connecting-ip': '1.2.3.4' })
  );

  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('60');
  const data = await res.json();
  expect(typeof data.error).toBe('string');
});

test('POST /api/tts proceeds (not 429) when the limiter allows a paid request', async () => {
  const env = {
    TTS_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const res = await app.handle(
    ttsRequest({ text: 'hello world', provider: 'elevenlabs' }, env, { 'cf-connecting-ip': '1.2.3.4' })
  );

  expect(res.status).not.toBe(429);
});

test('POST /api/tts free browser path is never limited', async () => {
  const env = {
    // No SONIOX_API_KEY anywhere, so this request cannot spend money — it must
    // never be subject to the limiter, even if the limiter would deny it.
    TTS_RATE_LIMITER: { limit: async () => ({ success: false }) },
  };
  const res = await app.handle(
    ttsRequest({ text: 'hello world', provider: 'browser' }, env, { 'cf-connecting-ip': '1.2.3.4' })
  );

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.provider).toBe('browser');
});

test('POST /api/tts fails open (proceeds, not 429) when the limiter throws', async () => {
  const env = {
    TTS_RATE_LIMITER: {
      limit: async () => {
        throw new Error('limiter unavailable');
      },
    },
  };
  const res = await app.handle(
    ttsRequest({ text: 'hello world', provider: 'elevenlabs' }, env, { 'cf-connecting-ip': '1.2.3.4' })
  );

  expect(res.status).not.toBe(429);
});

test('POST /api/tts proceeds (not 429) when no TTS_RATE_LIMITER binding is present', async () => {
  const env = {};
  const res = await app.handle(
    ttsRequest({ text: 'hello world', provider: 'elevenlabs' }, env, { 'cf-connecting-ip': '1.2.3.4' })
  );

  expect(res.status).not.toBe(429);
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
