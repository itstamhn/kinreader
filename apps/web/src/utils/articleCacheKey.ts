const CONTENT_KEY_PREFIX = 'content-sha256:';

async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-256 is unavailable in this browser');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function articleContentDigest(content: string): Promise<string> {
  return await sha256Hex(content.trim());
}

export async function articleCacheKey(input: {
  sourceUrl?: string;
  content: string;
}): Promise<string> {
  const sourceUrl = input.sourceUrl?.trim();
  const content = input.content.trim();
  const contentDigest = await articleContentDigest(content);
  if (sourceUrl) {
    return `source-sha256:${await sha256Hex(sourceUrl)}:${CONTENT_KEY_PREFIX}${contentDigest}`;
  }
  return `${CONTENT_KEY_PREFIX}${contentDigest}`;
}
