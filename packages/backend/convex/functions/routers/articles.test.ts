import { test, expect, beforeEach, afterEach } from 'bun:test';
import { convexTest } from 'convex-test';
// kitcn wraps registered Convex functions in a `Procedure` type that Convex's
// own `_generated/api.d.ts` (built by `ApiFromModules`'s structural check
// against its `RegisteredAction` shape) does not recognize -- `api.routers`
// there only exposes the raw-`action()` `users` module, dropping `articles`
// entirely from its public type. kitcn's generated shared/api.ts is the
// correct, type-complete surface for cRPC procedures and is still built on
// the same standard Convex `FunctionReference`s convex-test expects.
import { MINUTE, Ratelimit } from 'kitcn/ratelimit';
import { api } from '../../shared/api';
import schema from '../schema';
import { EXTRACT_GLOBAL_KEY } from '../../lib/rateLimiter';

// convex-test needs a map of every module a called function (or anything it
// transitively resolves through the deploy) might live in. It infers the
// functions-directory root from whichever entry contains "_generated", so
// that entry must be present even though its content is never exercised by
// this test. Keys are root-relative (convex-test's own convention); values
// are ordinary dynamic imports relative to *this* file.
const modules: Record<string, () => Promise<unknown>> = {
  './_generated/server.js': () => import('../_generated/server'),
  './routers/articles.ts': () => import('./articles'),
  './routers/articlesInternal.ts': () => import('./articlesInternal'),
  './lib/rateLimiter.ts': () => import('../../lib/rateLimiter'),
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

const rejectedUrls = [
  'http://localhost:3008/admin',
  'http://127.0.0.1/',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.0.0.5/',
  'http://192.168.1.1/',
  'http://172.16.0.1/',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'not-a-url',
];

for (const url of rejectedUrls) {
  test(`extract rejects ${url} without ever calling fetch`, async () => {
    let fetchCalled = false;
    stubFetch(() => {
      fetchCalled = true;
      return new Response('unused', { status: 200 });
    });

    const t = convexTest(schema, modules);

    await expect(t.action(api.routers.articles.extract, { url })).rejects.toThrow();
    expect(fetchCalled).toBe(false);
  });
}

test('extract accepts a normal https URL and still calls fetch (regression guard)', async () => {
  let fetchCalled = false;
  stubFetch((url) => {
    fetchCalled = true;
    if (url === 'https://example.com/article') {
      return htmlResponse(`
        <html>
          <head><title>Regular Article</title></head>
          <body><p>${'Some normal article body text. '.repeat(10)}</p></body>
        </html>
      `);
    }
    return new Response('not found', { status: 404 });
  });

  const t = convexTest(schema, modules);
  const result = await t.action(api.routers.articles.extract, {
    url: 'https://example.com/article',
  });

  expect(fetchCalled).toBe(true);
  expect(result.sourceUrl).toBe('https://example.com/article');
  expect(result.content).toContain('Some normal article body text');
});

test('extract accepts an x.com status URL (X extraction path still works)', async () => {
  let fetchCalled = false;
  stubFetch((url) => {
    fetchCalled = true;
    if (url.includes('api.fxtwitter.com')) {
      return new Response(
        JSON.stringify({
          tweet: {
            author: { name: 'Jane', screen_name: 'jane', avatar_url: 'https://example.com/avatar.png' },
            text: 'Hello world from X',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  });

  const t = convexTest(schema, modules);
  const result = await t.action(api.routers.articles.extract, {
    url: 'https://x.com/user/status/123',
  });

  expect(fetchCalled).toBe(true);
  expect(result.sourceType).toBe('x');
  expect(result.content).toBe('Hello world from X');
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

// The extraction limiters share `ratelimitState` with the TTS ones (see
// convex/lib/rateLimiter.ts); pre-load a bucket rather than hammer it.
async function drainExtractBucket(
  t: ReturnType<typeof convexTest>,
  bucket: { prefix: string; limit: number; key: string }
) {
  await t.run(async (ctx) => {
    const limiter = new Ratelimit({
      db: ctx.db as any,
      limiter: Ratelimit.slidingWindow(bucket.limit, MINUTE),
      prefix: bucket.prefix,
    });
    await limiter.limit(bucket.key, { count: bucket.limit });
  });
}

test('extract is rate limited per client and never fetches once the bucket is drained', async () => {
  let fetchCalled = false;
  stubFetch(() => {
    fetchCalled = true;
    return htmlResponse('<html><title>x</title><body>' + 'body text. '.repeat(20) + '</body></html>');
  });

  const t = convexTest(schema, modules);
  await drainExtractBucket(t, { prefix: 'extract-client', limit: 12, key: 'greedy-client' });

  await expect(
    t.action(api.routers.articles.extract, { url: 'https://example.com/a', clientId: 'greedy-client' })
  ).rejects.toThrow(/Too many article requests/);
  expect(fetchCalled).toBe(false);

  // Another client is unaffected by the first one's bucket.
  const other = await t.action(api.routers.articles.extract, {
    url: 'https://example.com/a',
    clientId: 'polite-client',
  });
  expect(fetchCalled).toBe(true);
  expect(other.sourceUrl).toBe('https://example.com/a');
});

test('the global extraction ceiling holds regardless of clientId', async () => {
  let fetchCalled = false;
  stubFetch(() => {
    fetchCalled = true;
    return htmlResponse('<html><body>unused</body></html>');
  });

  const t = convexTest(schema, modules);
  await drainExtractBucket(t, { prefix: 'extract-global', limit: 120, key: EXTRACT_GLOBAL_KEY });

  await expect(
    t.action(api.routers.articles.extract, { url: 'https://example.com/a', clientId: crypto.randomUUID() })
  ).rejects.toThrow(/Too many article requests/);
  expect(fetchCalled).toBe(false);
});
