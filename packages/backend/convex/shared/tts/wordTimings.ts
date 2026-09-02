export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export interface SonioxTimestampBatch {
  characters: string[];
  starts: number[];
  ends: number[];
}

export interface WordTimingAccumulator {
  append(batch: SonioxTimestampBatch): WordTiming[];
  flush(): WordTiming[];
}

// Any Unicode whitespace, including the no-break space web pages are full of.
const WHITESPACE = /^\s$/u;
// Invisible format and control characters (soft hyphens, zero-width spaces,
// byte-order marks, directional marks) that an article can carry and a
// speech engine has no reason to echo back.
const INVISIBLE = /^[\p{Cf}\p{Cc}]$/u;
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;
// How far ahead in the article to look for a character Soniox skipped to.
const LOOKAHEAD = 3;
// A word Soniox never voiced (a lone symbol, say) still needs a slot of its
// own on the timeline so every rendered word has a timing and timings stay
// strictly ordered.
const MIN_WORD_SECONDS = 0.001;

function round3(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * Folds Soniox's independent character-timestamp batches into rendered-word
 * timings. It intentionally waits for a whitespace boundary (or flush) so a
 * word split between WebSocket messages remains one timing.
 *
 * The returned characters are aligned to the article rather than required to
 * match it exactly: word text always comes from the article (so it matches
 * what is displayed and what the cache checks), and the characters Soniox
 * sends back only supply the times. Soniox may normalise whitespace, drop
 * invisible or unpronounceable characters, or substitute a quote or accent;
 * none of that should cost the listener exact sync for the whole article.
 * What it cannot recover from -- words Soniox never voiced at all -- surfaces
 * from `flush()` as an error.
 */
export function createWordTimingAccumulator(text: string): WordTimingAccumulator {
  const expected = [...text.trim()];
  let position = 0;
  let previousStart = -Infinity;
  let previousEnd = -Infinity;
  let lastEmittedEnd = 0;
  let partialText = '';
  let partialStart: number | undefined;
  let partialEnd: number | undefined;

  const emitPartial = (): WordTiming[] => {
    if (!partialText) return [];
    let start = Math.max(partialStart ?? lastEmittedEnd, lastEmittedEnd);
    let end = Math.max(partialEnd ?? start, round3(start + MIN_WORD_SECONDS));
    start = round3(start);
    end = round3(end);
    const word: WordTiming = { text: partialText, start, end };
    lastEmittedEnd = end;
    partialText = '';
    partialStart = undefined;
    partialEnd = undefined;
    return [word];
  };

  // Take the next article character, with the timing of the Soniox character
  // it lines up with (or none, when Soniox skipped it).
  const consume = (timing: { start: number; end: number } | null, words: WordTiming[]) => {
    const character = expected[position]!;
    position += 1;
    if (WHITESPACE.test(character)) {
      words.push(...emitPartial());
      return;
    }
    partialText += character;
    if (timing) {
      if (partialStart === undefined) partialStart = timing.start;
      partialEnd = timing.end;
    }
  };

  const align = (character: string, timing: { start: number; end: number }, words: WordTiming[]) => {
    for (;;) {
      if (position >= expected.length) {
        // Soniox voiced more than the article has (a trailing symbol, an
        // expansion): the extra sound belongs to the last word.
        if (partialText && !WHITESPACE.test(character)) partialEnd = Math.max(partialEnd ?? timing.end, timing.end);
        return;
      }
      const article = expected[position]!;
      if (character === article) {
        consume(timing, words);
        return;
      }
      const characterIsSpace = WHITESPACE.test(character);
      const articleIsSpace = WHITESPACE.test(article);
      if (characterIsSpace && articleIsSpace) {
        // A different kind of whitespace (a newline read as a space, a
        // no-break space as a plain one): still the same word boundary.
        consume(null, words);
        return;
      }
      if (!articleIsSpace && INVISIBLE.test(article)) {
        // An invisible character in the article that was never voiced: it
        // stays in the word's text and takes no time.
        consume(null, words);
        continue;
      }
      if (characterIsSpace) {
        // Soniox inserted a break the article does not have. Ignore it.
        return;
      }
      // Soniox skipped ahead over punctuation, symbols or whitespace?
      let skip = 0;
      for (let ahead = 1; ahead <= LOOKAHEAD && position + ahead < expected.length; ahead += 1) {
        const candidate = expected[position + ahead]!;
        if (candidate === character) {
          skip = ahead;
          break;
        }
        if (LETTER_OR_DIGIT.test(candidate)) break;
      }
      if (skip > 0) {
        for (let index = 0; index < skip; index += 1) consume(null, words);
        consume(timing, words);
        return;
      }
      // A one-for-one substitution (a normalised quote, an accent folded
      // away): the article's character keeps this timing.
      consume(timing, words);
      return;
    }
  };

  return {
    append(batch) {
      if (
        batch.characters.length !== batch.starts.length ||
        batch.characters.length !== batch.ends.length
      ) {
        throw new Error('Soniox timestamp arrays must have matching lengths');
      }
      const words: WordTiming[] = [];
      for (let index = 0; index < batch.characters.length; index += 1) {
        const entry = batch.characters[index]!;
        const start = batch.starts[index]!;
        const end = batch.ends[index]!;

        if (!entry) {
          throw new Error('Soniox character stream contained a non-character entry');
        }
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end < 0 ||
          end < start
        ) {
          throw new Error(`Invalid Soniox character timestamp at offset ${position}`);
        }
        if (start < previousStart || end < previousEnd) {
          throw new Error(`Soniox character timestamps are not globally monotonic at offset ${position}`);
        }
        previousStart = start;
        previousEnd = end;

        // An entry is normally one code point; a grapheme of several shares
        // the one timing.
        for (const character of entry) align(character, { start, end }, words);
      }
      return words;
    },

    flush() {
      const words: WordTiming[] = [];
      // Whatever Soniox never echoed: trailing whitespace, invisible marks
      // and punctuation are fine, but letters and digits are words the
      // listener will not hear at the highlighted moment.
      let unvoiced = 0;
      while (position < expected.length) {
        if (LETTER_OR_DIGIT.test(expected[position]!)) unvoiced += 1;
        consume(null, words);
      }
      if (unvoiced > 0) {
        throw new Error(
          `Incomplete Soniox character stream: ${unvoiced} of ${expected.length} characters were never voiced`
        );
      }
      words.push(...emitPartial());
      return words;
    },
  };
}
