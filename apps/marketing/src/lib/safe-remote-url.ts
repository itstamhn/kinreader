// The PNG card composites the article's hero image, which means *this Worker*
// fetches a URL supplied in a query parameter. The SVG version never did -- it
// emitted an <image href> and left the fetch to whatever rendered the SVG.
//
// So this is a new server-side fetch of an attacker-controlled URL, and it gets
// the same guard the article extractor already uses (plan 011,
// packages/backend/convex/routers/articles.ts). Kept as its own module here
// rather than imported across the package boundary: the backend's copy runs in
// Convex, and a shared dependency between the marketing site and the Convex
// functions would be a coupling neither wants.

export function assertSafeRemoteUrl(input: string): URL {
  const parsed = new URL(input);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }

  const host = parsed.hostname.toLowerCase();

  // Obvious local / private / link-local targets by name.
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('URL host is not permitted');
  }

  // Literal IPs in private, loopback, link-local and carrier-NAT ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      throw new Error('URL host is not permitted');
    }
  }

  // IPv6 loopback / unique-local / link-local, including v4-mapped forms.
  if (host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::' || /^f[cd]/i.test(h) || /^fe80:/i.test(h) || h.includes('127.0.0.1')) {
      throw new Error('URL host is not permitted');
    }
  }

  return parsed;
}
