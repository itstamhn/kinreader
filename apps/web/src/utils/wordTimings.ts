import type { WordTiming } from '../types';

export interface SonioxTimestampBatch {
  characters: string[];
  starts: number[];
  ends: number[];
}

export interface WordTimingAccumulator {
  append(batch: SonioxTimestampBatch): WordTiming[];
  flush(): WordTiming[];
}

/**
 * Folds Soniox's independent character-timestamp batches into rendered-word
 * timings. It intentionally waits for a whitespace boundary (or flush) so a
 * word split between WebSocket messages remains one timing.
 */
export function createWordTimingAccumulator(text: string): WordTimingAccumulator {
  const expectedWords = text.split(/\s+/).filter(Boolean);
  let nextWordIndex = 0;
  let partialText = '';
  let partialStart: number | undefined;
  let partialEnd: number | undefined;

  const emitPartial = (): WordTiming[] => {
    if (!partialText || partialStart === undefined || partialEnd === undefined) return [];

    const word: WordTiming = {
      // The displayed token is authoritative. Step 0 verified Soniox returns
      // characters verbatim, so this also makes the required 1:1 contract
      // explicit at the API boundary.
      text: expectedWords[nextWordIndex] ?? partialText,
      start: partialStart,
      end: partialEnd,
    };
    nextWordIndex += 1;
    partialText = '';
    partialStart = undefined;
    partialEnd = undefined;
    return [word];
  };

  return {
    append(batch) {
      const words: WordTiming[] = [];
      for (let index = 0; index < batch.characters.length; index += 1) {
        const character = batch.characters[index]!;
        const start = batch.starts[index]!;
        const end = batch.ends[index]!;

        if (/\s/.test(character)) {
          words.push(...emitPartial());
          continue;
        }

        if (!partialText) partialStart = start;
        partialText += character;
        partialEnd = end;
      }
      return words;
    },

    flush() {
      return emitPartial();
    },
  };
}
