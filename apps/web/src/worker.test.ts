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

test('POST /api/tts returns 404 (moved to Convex)', async () => {
  const res = await worker.fetch(
    new Request('http://localhost/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    mockEnv
  );

  expect(res.status).toBe(404);
});

test('POST /api/auth/* returns 404 (handled by Better Auth on Convex)', async () => {
  const res1 = await worker.fetch(
    new Request('http://localhost/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    }),
    mockEnv
  );
  expect(res1.status).toBe(404);

  const res2 = await worker.fetch(
    new Request('http://localhost/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', code: '123456' }),
    }),
    mockEnv
  );
  expect(res2.status).toBe(404);
});

test('GET / serves SPA assets from env.ASSETS', async () => {
  const res = await worker.fetch(new Request('http://localhost/'), mockEnv);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain('<html>SPA Shell</html>');
  expect(res.headers.get('Content-Security-Policy')).toBeDefined();
});

const DEAD_ROUTES = ['api/extract', 'api/tts', 'api/og', '/r/', 'api/auth'];

test('no file under src/ references a route that moved away from this Worker', async () => {
  const glob = new Bun.Glob('**/*.{ts,tsx}');
  const offenders: string[] = [];

  for await (const relPath of glob.scan({ cwd: import.meta.dir })) {
    if (relPath.includes('.test.')) continue; // test files permitted

    const file = Bun.file(`${import.meta.dir}/${relPath}`);
    const text = await file.text();
    for (const dead of DEAD_ROUTES) {
      if (text.includes(dead)) {
        offenders.push(`${relPath} references "${dead}"`);
      }
    }
  }

  expect(offenders).toEqual([]);
});
