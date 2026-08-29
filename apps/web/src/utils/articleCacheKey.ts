const CONTENT_KEY_PREFIX = 'content-sha256:';

function fallbackContentHash(content: string): string {
  // Web Crypto is present in every supported production browser. This
  // deterministic 128-bit fallback keeps cache identity safe in unusual
  // non-secure/test WebViews where SubtleCrypto is unavailable.
  const bytes = new TextEncoder().encode(content);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds
    .map((seed) => {
      let hash = seed;
      for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193);
        hash ^= hash >>> 13;
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
}

export async function articleCacheKey(input: {
  sourceUrl?: string;
  content: string;
}): Promise<string> {
  const sourceUrl = input.sourceUrl?.trim();
  if (sourceUrl) return sourceUrl;

  const content = input.content.trim();
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(content)
    );
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    );
    return `${CONTENT_KEY_PREFIX}${hex}`;
  }

  return `content-hash:${fallbackContentHash(content)}`;
}
