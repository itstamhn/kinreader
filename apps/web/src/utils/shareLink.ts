// Share links are `https://kinreader.com/r/<id>?t=&a=&img=` (the Astro share
// page in apps/marketing renders the OG card from those parameters and then
// forwards to `app.kinreader.com/?read=<id>`). The id is the article's source
// URL, base64url-encoded: no table, no public write endpoint, nothing to
// expire, and the recipient's app can resolve it offline into the same
// `?url=` load path every other deep link uses. Plan 016 sketched a stored
// `shares` record instead; the encoded id keeps its user-facing contract with
// none of its storage or abuse surface, and the OG parameters stay escaped by
// the marketing page exactly as plan 004 left them.

export const SHARE_PAGE_ORIGIN = 'https://kinreader.com';

const MAX_SHARE_URL_CHARS = 2048;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function isShareableUrl(candidate: string): URL | null {
  if (candidate.length > MAX_SHARE_URL_CHARS) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The opaque id carried by `/r/:id` and `?read=`, or null if the URL cannot be shared. */
export function encodeShareId(sourceUrl: string): string | null {
  const parsed = isShareableUrl(sourceUrl.trim());
  if (!parsed) return null;
  return toBase64Url(new TextEncoder().encode(parsed.toString()));
}

/** Resolves a `?read=` id back to an http(s) source URL, or null when it is not one. */
export function decodeShareId(id: string): string | null {
  const bytes = fromBase64Url(id.trim());
  if (!bytes) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return isShareableUrl(decoded)?.toString() ?? null;
}

export function buildShareLink(article: {
  sourceUrl?: string;
  title: string;
  author?: string;
  image?: string;
}): string | null {
  if (!article.sourceUrl) return null;
  const id = encodeShareId(article.sourceUrl);
  if (!id) return null;
  const link = new URL(`/r/${id}`, SHARE_PAGE_ORIGIN);
  link.searchParams.set('t', article.title.slice(0, 200));
  if (article.author) link.searchParams.set('a', article.author.slice(0, 100));
  if (article.image && /^https:\/\//.test(article.image)) link.searchParams.set('img', article.image);
  return link.toString();
}
