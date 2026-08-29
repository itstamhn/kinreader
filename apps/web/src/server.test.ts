import { test, expect } from 'bun:test';
import { app } from './server';

test('GET /api/health returns 200 with status ok', async () => {
  const res = await app.handle(new Request('http://localhost/api/health'));

  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.status).toBe('ok');
  expect(typeof data.timestamp).toBe('string');
});

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

test('POST /api/auth routes no longer exist on the Spiceflow app (404)', async () => {
  const res1 = await app.handle(
    new Request('http://localhost/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    })
  );
  expect(res1.status).toBe(404);

  const res2 = await app.handle(
    new Request('http://localhost/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', code: '123456' }),
    })
  );
  expect(res2.status).toBe(404);
});

const DEAD_ROUTES = ['api/extract', 'api/tts', 'api/og', '/r/', 'api/auth'];

test('no file under src/ references a route that moved away from this Worker', async () => {
  const glob = new Bun.Glob('**/*.{ts,tsx}');
  const offenders: string[] = [];

  for await (const relPath of glob.scan({ cwd: import.meta.dir })) {
    if (relPath === 'server.test.ts') continue; // this file -- permitted, see above

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
