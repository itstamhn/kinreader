export default {
  async fetch(
    request: Request,
    env: { ASSETS: { fetch: (req: Request) => Promise<Response> } }
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

    // 3. Handle Worker API routes directly without external framework
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
    }

    // 4. Attach Security & HSTS Headers
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    newHeaders.set('X-Content-Type-Options', 'nosniff');
    newHeaders.set('X-Frame-Options', 'SAMEORIGIN');
    newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    newHeaders.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.convex.cloud https://*.convex.site wss://*.convex.cloud; media-src 'self' data: blob: https:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'"
    );

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};
