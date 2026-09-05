import { test, expect } from 'bun:test';
import worker from './worker';

const mockEnv = {
  ASSETS: {
    fetch: async () =>
      new Response('<html>SPA Shell</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
  },
};

test('GET /api/health returns 200 with status ok and security headers', async () => {
  const res = await worker.fetch(new Request('http://localhost/api/health'), mockEnv);

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.status).toBe('ok');
  expect(typeof data.timestamp).toBe('string');
  expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
});

test('POST /api/extract returns 404 (moved to Convex)', async () => {
  const res = await worker.fetch(
    new Request('http://localhost/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    mockEnv
  );

  expect(res.status).toBe(404);
});

test('/api/tts/* proxies to Convex HTTP router and preserves security headers', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      return new Response('audio-stream-bytes', {
        status: 200,
        headers: {
          'Content-Type': 'audio/mpeg',
        },
      });
    }) as any;

    const res = await worker.fetch(
      new Request('http://localhost/api/tts/stream?text=hello'),
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res.headers.get('Strict-Transport-Security')).toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/api/auth/* proxies to Convex HTTP router and preserves security headers', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'better-auth.session_token=test-token; Path=/',
        },
      });
    }) as any;

    const res = await worker.fetch(
      new Request('http://localhost/api/auth/get-session'),
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Strict-Transport-Security')).toBeDefined();
    expect(res.headers.get('Set-Cookie')).toContain('better-auth.session_token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('auth redirects keep cookies and location without downloadable entity headers', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      return new Response(null, {
        status: 302,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '0',
          Location: 'https://app.kinreader.com/',
          'Set-Cookie': 'better-auth.session_token=test-token; Path=/; Secure; HttpOnly',
        },
      });
    }) as any;

    const res = await worker.fetch(
      new Request(
        'http://localhost/api/auth/magic-link/verify?token=test&callbackURL=http%3A%2F%2Flocalhost'
      ),
      mockEnv
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://app.kinreader.com/');
    expect(res.headers.get('Set-Cookie')).toContain('better-auth.session_token');
    expect(res.headers.get('Content-Type')).toBeNull();
    expect(res.headers.get('Content-Length')).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET / serves SPA assets from env.ASSETS', async () => {
  const res = await worker.fetch(new Request('http://localhost/'), mockEnv);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('<html>SPA Shell</html>');
  expect(res.headers.get('Content-Security-Policy')).toBeDefined();
});

const DEAD_ROUTES = ['api/extract', 'api/og', '/r/'];

// The share-link builder deliberately targets the *marketing* origin's
// `/r/:id` (an absolute `https://kinreader.com/r/...` URL), which is not a
// route on this Worker. Files may also name that absolute form in comments.
const ALLOWED_FILES = new Set(['utils/shareLink.ts']);
const ALLOWED_ABSOLUTE_FORMS = /kinreader\.com\/r\//g;

test('no file under src/ references a route that moved away from this Worker', async () => {
  const glob = new Bun.Glob('**/*.{ts,tsx}');
  const offenders: string[] = [];

  for await (const relPath of glob.scan({ cwd: import.meta.dir })) {
    if (relPath.includes('.test.')) continue; // test files permitted
    if (ALLOWED_FILES.has(relPath)) continue;

    const file = Bun.file(`${import.meta.dir}/${relPath}`);
    const text = (await file.text()).replace(ALLOWED_ABSOLUTE_FORMS, '');
    for (const dead of DEAD_ROUTES) {
      if (text.includes(dead)) {
        offenders.push(`${relPath} references "${dead}"`);
      }
    }
  }

  expect(offenders).toEqual([]);
});


test('sample narration supports full, partial, suffix and invalid byte ranges for word seeking', async () => {
  const env = { ASSETS: { fetch: async (request: Request) => {
    expect(request.headers.get('Range')).toBeNull();
    return new Response('0123456789', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '10', ETag: '"sample"' } });
  } } };
  for (const [range, status, body, contentRange] of [
    [undefined, 200, '0123456789', null],
    ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
    ['bytes=7-', 206, '789', 'bytes 7-9/10'],
    ['bytes=-3', 206, '789', 'bytes 7-9/10'],
    ['bytes=20-', 416, '', 'bytes */10'],
  ] as const) {
    const response = await worker.fetch(new Request('https://app.kinreader.com/sample_audio.mp3', { headers: range ? { Range: range } : {} }), env);
    expect(response.status).toBe(status);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(await response.text()).toBe(body);
  }
  const changed = await worker.fetch(new Request('https://app.kinreader.com/sample_audio.mp3', { headers: { Range: 'bytes=2-5', 'If-Range': '"older"' } }), env);
  expect(changed.status).toBe(200);
  expect(await changed.text()).toBe('0123456789');
});
