// How much of an article the reader narrates in one track.
//
// Two hard ceilings sit behind these numbers: a Convex array holds at most
// 8192 entries, so a cached track's `words` cannot exceed that, and a single
// Soniox session should not be asked for tens of minutes of audio. Rather than
// fail on a long piece, the reader narrates the longest sentence-aligned
// prefix that fits and says so; the text that is narrated is also the text
// that is displayed, cached and pre-generated, so every path agrees on it.

export const MAX_NARRATION_CHARS = 45000;
export const MAX_NARRATION_WORDS = 8000;

export interface NarrationText {
  text: string;
  truncated: boolean;
  totalWords: number;
  narratedWords: number;
}

export function narrationText(content: string): NarrationText {
  const full = content.trim();
  const words = full.split(/\s+/).filter(Boolean);
  if (full.length <= MAX_NARRATION_CHARS && words.length <= MAX_NARRATION_WORDS) {
    return { text: full, truncated: false, totalWords: words.length, narratedWords: words.length };
  }

  // Character ceiling first, then the word ceiling, whichever bites sooner.
  let cut = Math.min(full.length, MAX_NARRATION_CHARS);
  if (words.length > MAX_NARRATION_WORDS) {
    let seen = 0;
    let index = 0;
    while (index < full.length && seen < MAX_NARRATION_WORDS) {
      while (index < full.length && /\s/.test(full[index]!)) index += 1;
      while (index < full.length && !/\s/.test(full[index]!)) index += 1;
      seen += 1;
    }
    cut = Math.min(cut, index);
  }

  // Back up to the end of a sentence when one is reasonably close, so the
  // narration stops at a full stop rather than mid-clause.
  const head = full.slice(0, cut);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('.\n'));
  const text = (sentenceEnd > cut * 0.8 ? head.slice(0, sentenceEnd + 1) : head).trim();
  const narratedWords = text.split(/\s+/).filter(Boolean).length;
  return { text, truncated: true, totalWords: words.length, narratedWords };
}
