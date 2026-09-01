const DEFAULT_CONVEX_SITE_ORIGIN = 'https://notable-camel-807.convex.site';

export default {
  async fetch(
    request: Request,
    env: {
      ASSETS: { fetch: (req: Request) => Promise<Response> };
      // The Convex deployment's HTTP-actions origin (`<deployment>.convex.site`).
      // Set per environment in wrangler.jsonc `vars`; the fallback is production.
      CONVEX_SITE_ORIGIN?: string;
    }
  ): Promise<Response> {
    const url = new URL(request.url);

    // 1. Check if the incoming client connection was HTTP
    let isHttp = false;
    const cfVisitor = request.headers.get('cf-visitor');
    if (cfVisitor) {
      try {
        const parsed = JSON.parse(cfVisitor);
        if (parsed.scheme === 'http') isHttp = true;
      } catch {}
    }
    if (request.headers.get('x-forwarded-proto') === 'http') {
      isHttp = true;
    }
    if (url.protocol === 'http:') {
      isHttp = true;
    }

    // 2. Force 301 Permanent Redirect to HTTPS
    if (isHttp && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      const httpsUrl = `https://${url.host}${url.pathname}${url.search}`;
      return new Response(null, {
        status: 301,
        headers: {
          Location: httpsUrl,
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        },
      });
    }

    // 3. Handle Worker API routes & Proxy Better Auth to Convex
    let response: Response;
    if (url.pathname === '/api/health') {
      response = new Response(
        JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } else if (url.pathname.startsWith('/api/auth') || url.pathname.startsWith('/api/tts')) {
      // Proxy Better Auth & TTS streaming endpoints directly to Convex HTTP router
      const convexSiteOrigin = env.CONVEX_SITE_ORIGIN || DEFAULT_CONVEX_SITE_ORIGIN;
      const targetUrl = `${convexSiteOrigin}${url.pathname}${url.search}`;

      const forwardedHeaders = new Headers(request.headers);
      forwardedHeaders.delete('host');

      const backendRes = await fetch(targetUrl, {
        method: request.method,
        headers: forwardedHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'manual',
      });

      const responseHeaders = new Headers();
      for (const [key, value] of backendRes.headers.entries()) {
        if (key.toLowerCase() !== 'set-cookie') {
          responseHeaders.set(key, value);
        }
      }

      // Better Auth emits empty redirects with JSON entity headers. Desktop
      // browsers generally ignore them, but mobile mail webviews can classify
      // the navigation as a downloadable JSON file before following Location.
      if (backendRes.status >= 300 && backendRes.status < 400) {
        responseHeaders.delete('Content-Type');
        responseHeaders.delete('Content-Length');
      }

      // Preserve all Set-Cookie headers without collapsing or overriding
      const cookies = typeof backendRes.headers.getSetCookie === 'function'
        ? backendRes.headers.getSetCookie()
        : [backendRes.headers.get('set-cookie')].filter(Boolean) as string[];

      for (const cookie of cookies) {
        responseHeaders.append('Set-Cookie', cookie);
      }

      responseHeaders.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
      responseHeaders.set('X-Content-Type-Options', 'nosniff');
      responseHeaders.set('X-Frame-Options', 'SAMEORIGIN');
      responseHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');

      return new Response(backendRes.body, {
        status: backendRes.status,
        statusText: backendRes.statusText,
        headers: responseHeaders,
      });
    } else if (url.pathname.startsWith('/api')) {
      // Dead API route check (all API data operations live on Convex)
      response = new Response(
        JSON.stringify({
          error: 'Not Found',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } else {
      // Serve static SPA assets from dist/
      response = await env.ASSETS.fetch(request);
      if (response.status === 404 && request.method === 'GET') {
        const indexUrl = new URL('/index.html', request.url);
        response = await env.ASSETS.fetch(new Request(indexUrl.toString(), request));
      }
    }

    // 4. Attach Security & HSTS Headers
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    newHeaders.set('X-Content-Type-Options', 'nosniff');
    newHeaders.set('X-Frame-Options', 'SAMEORIGIN');
    newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    newHeaders.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.convex.cloud https://*.convex.site wss://*.convex.cloud wss://tts-rt.soniox.com; media-src 'self' data: blob: https:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'"
    );

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};
