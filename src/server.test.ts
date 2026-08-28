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
