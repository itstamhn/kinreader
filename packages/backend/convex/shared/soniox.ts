const MAX_SONIOX_CHUNK_CHARS = 450;

/**
 * Break text into bounded Soniox real-time messages without applying the REST
 * fallback's historic 900-character cap. Chunks are contiguous slices: Soniox
 * reconstructs streamed text by direct concatenation, so separators must stay
 * in one of the adjacent messages instead of being trimmed and re-inserted.
 */
export function splitTextIntoSonioxChunks(fullText: string, maxChunkSize = MAX_SONIOX_CHUNK_CHARS): string[] {
  const textToSynthesize = fullText.trim();
  const chunks: string[] = [];
  for (let start = 0; start < textToSynthesize.length; start += maxChunkSize) {
    chunks.push(textToSynthesize.slice(start, start + maxChunkSize));
  }
  return chunks;
}
