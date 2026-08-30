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
  const expectedText = text.trim();
  let receivedLength = 0;
  let previousStart = -Infinity;
  let previousEnd = -Infinity;
  let partialText = '';
  let partialStart: number | undefined;
  let partialEnd: number | undefined;

  const emitPartial = (): WordTiming[] => {
    if (!partialText || partialStart === undefined || partialEnd === undefined) return [];

    const word: WordTiming = {
      text: partialText,
      start: partialStart,
      end: partialEnd,
    };
    partialText = '';
    partialStart = undefined;
    partialEnd = undefined;
    return [word];
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
        const character = batch.characters[index]!;
        const start = batch.starts[index]!;
        const end = batch.ends[index]!;

        if (!character || [...character].length !== 1) {
          throw new Error('Soniox character stream contained a non-character entry');
        }
        const expectedCharacter = expectedText.slice(receivedLength, receivedLength + character.length);
        if (character !== expectedCharacter) {
          throw new Error(`Soniox character stream mismatch at offset ${receivedLength}`);
        }
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end < 0 ||
          end < start
        ) {
          throw new Error(`Invalid Soniox character timestamp at offset ${receivedLength}`);
        }
        if (start < previousStart || end < previousEnd) {
          throw new Error(`Soniox character timestamps are not globally monotonic at offset ${receivedLength}`);
        }
        receivedLength += character.length;
        previousStart = start;
        previousEnd = end;

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
      if (receivedLength !== expectedText.length) {
        throw new Error(
          `Incomplete Soniox character stream: received ${receivedLength} of ${expectedText.length} characters`
        );
      }
      return emitPartial();
    },
  };
}
