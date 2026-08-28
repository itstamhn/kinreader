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

test('POST /api/extract with no url returns 400', async () => {
  const res = await app.handle(
    new Request('http://localhost/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  );

  expect(res.status).toBe(400);
  const data = await res.json();
  expect(data.error).toBe('URL is required');
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
