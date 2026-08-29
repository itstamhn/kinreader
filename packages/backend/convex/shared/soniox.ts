const MAX_SONIOX_CHUNK_CHARS = 450;

/**
 * Break text into Soniox real-time messages without applying the REST
 * fallback's historic 900-character cap. Sentence boundaries keep the
 * generated speech natural; overlong sentences fall back to word boundaries.
 */
export function splitTextIntoSonioxChunks(fullText: string, maxChunkSize = MAX_SONIOX_CHUNK_CHARS): string[] {
  const textToSynthesize = fullText.trim();

  if (textToSynthesize.length <= maxChunkSize) {
    return [textToSynthesize];
  }

  const chunks: string[] = [];
  const sentences = textToSynthesize.match(/[^.!?\n]+[.!?\n]+(?:\s+|$)|[^.!?\n]+$/g) || [textToSynthesize];
  let curChunk = '';

  for (const rawSent of sentences) {
    const sent = rawSent.trim();
    if (!sent) continue;

    if ((curChunk + ' ' + sent).trim().length <= maxChunkSize) {
      curChunk = curChunk ? curChunk + ' ' + sent : sent;
    } else {
      if (curChunk) {
        chunks.push(curChunk.trim());
        curChunk = '';
      }
      if (sent.length <= maxChunkSize) {
        curChunk = sent;
      } else {
        const words = sent.split(/\s+/);
        for (const word of words) {
          if ((curChunk + ' ' + word).trim().length <= maxChunkSize) {
            curChunk = curChunk ? curChunk + ' ' + word : word;
          } else {
            if (curChunk) chunks.push(curChunk.trim());
            curChunk = word;
          }
        }
      }
    }
  }
  if (curChunk) chunks.push(curChunk.trim());
  return chunks.filter(Boolean);
}
