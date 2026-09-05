export function assertPublicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }

  const host = parsed.hostname.toLowerCase();

  // Reject obvious local / private / link-local targets by name.
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('URL host is not permitted');
  }

  // Reject literal IPs in private, loopback, and link-local ranges.
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
