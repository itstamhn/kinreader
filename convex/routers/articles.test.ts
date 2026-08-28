import { test, expect, beforeEach, afterEach } from 'bun:test';
import { convexTest } from 'convex-test';
// kitcn wraps registered Convex functions in a `Procedure` type that Convex's
// own `_generated/api.d.ts` (built by `ApiFromModules`'s structural check
// against its `RegisteredAction` shape) does not recognize -- `api.routers`
// there only exposes the raw-`action()` `users` module, dropping `articles`
// entirely from its public type. kitcn's generated shared/api.ts is the
// correct, type-complete surface for cRPC procedures and is still built on
// the same standard Convex `FunctionReference`s convex-test expects.
import { api } from '../shared/api';
import schema from '../schema';

// convex-test needs a map of every module a called function (or anything it
// transitively resolves through the deploy) might live in. It infers the
// functions-directory root from whichever entry contains "_generated", so
// that entry must be present even though its content is never exercised by
// this test. Keys are root-relative (convex-test's own convention); values
// are ordinary dynamic imports relative to *this* file.
const modules: Record<string, () => Promise<unknown>> = {
  './_generated/server.js': () => import('../_generated/server'),
  './routers/articles.ts': () => import('./articles'),
};

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function stubFetch(impl: (url: string) => Promise<Response> | Response) {
  global.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    return Promise.resolve(impl(url));
  }) as typeof fetch;
}

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
}

test('extract returns the article shape for a page with OG metadata', async () => {
  stubFetch((url) => {
    if (url === 'https://example.com/article') {
      return htmlResponse(`
        <html>
          <head>
            <title>Fallback Title</title>
            <meta property="og:title" content="A Real Article" />
            <meta property="og:image" content="https://example.com/cover.png" />
            <meta name="author" content="Jane Doe" />
          </head>
          <body><p>${'Real article body content. '.repeat(10)}</p></body>
        </html>
      `);
    }
    return new Response('not found', { status: 404 });
  });

  const t = convexTest(schema, modules);
  const result = await t.action(api.routers.articles.extract, {
    url: 'https://example.com/article',
  });

  expect(result.title).toBe('A Real Article');
  expect(result.author).toBe('Jane Doe');
  expect(result.image).toBe('https://example.com/cover.png');
  expect(result.sourceUrl).toBe('https://example.com/article');
  expect(result.sourceType).toBe('article');
  expect(result.content).toContain('Real article body content');
  expect(result.truncated).toBe(false);
});

test('extract rejects a missing url instead of calling any provider', async () => {
  let fetchCalled = false;
  stubFetch(() => {
    fetchCalled = true;
    return new Response('unused', { status: 200 });
  });

  const t = convexTest(schema, modules);

  await expect(t.action(api.routers.articles.extract, { url: '' })).rejects.toThrow();
  expect(fetchCalled).toBe(false);
});

test('extract returns a handled fallback (not a throw) when every fetch fails', async () => {
  stubFetch(() => {
    throw new TypeError('network unreachable');
  });

  const t = convexTest(schema, modules);
  const result = await t.action(api.routers.articles.extract, {
    url: 'https://unreachable.example/page',
  });

  expect(result.content).toBe('No readable text could be extracted from this page.');
  expect(result.sourceType).toBe('article');
  expect(result.truncated).toBe(false);
});

test('extract truncates content over the 1MB guard and sets truncated: true', async () => {
  const hugeParagraph = `<p>${'word '.repeat(400_000)}</p>`; // ~2,000,000 chars of body text
  stubFetch((url) => {
    if (url === 'https://example.com/huge') {
      return htmlResponse(`<html><head><title>Huge Page</title></head><body>${hugeParagraph}</body></html>`);
    }
    return new Response('not found', { status: 404 });
  });

  const t = convexTest(schema, modules);
  const result = await t.action(api.routers.articles.extract, {
    url: 'https://example.com/huge',
  });

  expect(result.truncated).toBe(true);
  expect(result.content.length).toBeLessThanOrEqual(900_000);
});
