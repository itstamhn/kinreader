import { test, expect, afterEach } from 'bun:test';
import { renderOgCardPng } from '../src/lib/og-card-png';
import { assertSafeRemoteUrl } from '../src/lib/safe-remote-url';

// A 1x1 PNG, used as the stubbed hero image.
const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0)
);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function pngSize(png: Uint8Array): { width: number; height: number } {
  // IHDR is the first chunk: 8-byte signature, 4-byte length, 4-byte type,
  // then width and height as big-endian uint32s.
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

test('renderOgCardPng returns a real 1200x630 PNG', async () => {
  const png = await renderOgCardPng({ title: 'Hello World', author: 'Dan Koe' });

  // The whole point of this renderer: X and Facebook do not render SVG, so the
  // bytes have to be an actual raster image.
  expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
});

test('renderOgCardPng renders an overlong title without failing', async () => {
  const png = await renderOgCardPng({ title: 'x'.repeat(400) });
  expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
});

test('renderOgCardPng composites a hero image when the URL is fetchable', async () => {
  let requested = '';
  globalThis.fetch = (async (input: any) => {
    requested = typeof input === 'string' ? input : String(input);
    return new Response(TINY_PNG, { headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;

  const withImage = await renderOgCardPng({
    title: 'Test',
    image: 'https://example.com/hero.png',
  });

  expect(requested).toBe('https://example.com/hero.png');
  expect(pngSize(withImage)).toEqual({ width: 1200, height: 630 });
});

test('renderOgCardPng never fetches a blocked host, and falls back to the placeholder', async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response(TINY_PNG, { headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;

  // The SVG version emitted an <image href> and let the client fetch it. This
  // renderer fetches it server-side, so a query parameter now decides what the
  // Worker connects to -- the guard is the whole reason that is safe.
  for (const image of [
    'http://127.0.0.1:8080/x.png',
    'http://localhost/x.png',
    'http://10.0.0.5/x.png',
    'http://169.254.169.254/latest/meta-data/',
    'javascript:alert(1)',
  ]) {
    const png = await renderOgCardPng({ title: 'Test', image });
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
  }

  expect(called).toBe(false);
});

test('renderOgCardPng ignores a response that is not an image', async () => {
  globalThis.fetch = (async () =>
    new Response('<html>not an image</html>', {
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch;

  const png = await renderOgCardPng({ title: 'Test', image: 'https://example.com/page.html' });
  expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
});

test('assertSafeRemoteUrl rejects private, loopback and link-local targets', () => {
  for (const blocked of [
    'http://localhost/a.png',
    'http://0.0.0.0/a.png',
    'http://thing.internal/a.png',
    'http://printer.local/a.png',
    'http://127.0.0.1/a.png',
    'http://10.1.2.3/a.png',
    'http://172.16.0.1/a.png',
    'http://192.168.1.1/a.png',
    'http://169.254.169.254/a.png',
    'http://100.64.0.1/a.png',
    'http://[::1]/a.png',
    'http://[fe80::1]/a.png',
    'ftp://example.com/a.png',
    'data:image/png;base64,AAAA',
  ]) {
    expect(() => assertSafeRemoteUrl(blocked)).toThrow();
  }
});

test('assertSafeRemoteUrl allows an ordinary public image URL', () => {
  expect(assertSafeRemoteUrl('https://example.com/a.png').href).toBe('https://example.com/a.png');
  expect(assertSafeRemoteUrl('https://8.8.8.8/a.png').hostname).toBe('8.8.8.8');
});
