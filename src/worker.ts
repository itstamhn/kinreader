import { app } from './server';

export default {
  async fetch(request: Request, env: { ASSETS: { fetch: (req: Request) => Promise<Response> } }): Promise<Response> {
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
          'Location': httpsUrl,
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        },
      });
    }
    
    // 3. Handle Spiceflow backend API routes & deep-link share routes
    let response: Response;
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/r/')) {
      (request as any).env = env;
      response = await app.handle(request);
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

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};
