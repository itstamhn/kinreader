import { expect, test } from 'bun:test';
import { createWordTimingAccumulator } from './wordTimings';

test('keeps a word open across timestamp batches and only emits it after its delimiter arrives', () => {
  const accumulator = createWordTimingAccumulator('Hello world');

  expect(
    accumulator.append({
      characters: ['H', 'e', 'l'],
      starts: [0.1, 0.12, 0.14],
      ends: [0.11, 0.13, 0.15],
    })
  ).toEqual([]);
  expect(
    accumulator.append({
      characters: ['l', 'o', ' '],
      starts: [0.16, 0.18, 0.2],
      ends: [0.17, 0.19, 0.21],
    })
  ).toEqual([{ text: 'Hello', start: 0.1, end: 0.19 }]);
  expect(
    accumulator.append({
      characters: ['w', 'o', 'r', 'l', 'd'],
      starts: [0.3, 0.32, 0.34, 0.36, 0.38],
      ends: [0.31, 0.33, 0.35, 0.37, 0.39],
    })
  ).toEqual([]);
  expect(
    accumulator.flush()
  ).toEqual([{ text: 'world', start: 0.3, end: 0.39 }]);
});

test('does not use leading or whitespace-only batch timestamps as a word start', () => {
  const accumulator = createWordTimingAccumulator('A B');

  expect(
    accumulator.append({
      characters: ['A'],
      starts: [0.12],
      ends: [0.2],
    })
  ).toEqual([]);
  expect(
    accumulator.append({
      characters: [' '],
      starts: [0.21],
      ends: [0.29],
    })
  ).toEqual([{ text: 'A', start: 0.12, end: 0.2 }]);
  expect(
    accumulator.append({
      characters: ['B'],
      starts: [0.31],
      ends: [0.42],
    })
  ).toEqual([]);
  expect(accumulator.flush()).toEqual([{ text: 'B', start: 0.31, end: 0.42 }]);
});

test('emits exactly the rendered whitespace tokens after single-character and whitespace-only batches', () => {
  const text = 'One\n two   three';
  const accumulator = createWordTimingAccumulator(text);
  const emitted = [
    ...accumulator.append({
      characters: ['O'],
      starts: [0.1],
      ends: [0.12],
    }),
    ...accumulator.append({
      characters: ['n', 'e', '\n'],
      starts: [0.13, 0.15, 0.17],
      ends: [0.14, 0.16, 0.2],
    }),
    ...accumulator.append({
      characters: [' '],
      starts: [0.21],
      ends: [0.22],
    }),
    ...accumulator.append({
      characters: ['t', 'w', 'o', ' ', ' ', ' '],
      starts: [0.3, 0.32, 0.34, 0.36, 0.37, 0.38],
      ends: [0.31, 0.33, 0.35, 0.365, 0.375, 0.385],
    }),
    ...accumulator.append({
      characters: ['t', 'h', 'r', 'e', 'e'],
      starts: [0.4, 0.42, 0.44, 0.46, 0.48],
      ends: [0.41, 0.43, 0.45, 0.47, 0.49],
    }),
    ...accumulator.flush(),
  ];

  expect(emitted.map((word) => word.text)).toEqual(text.split(/\s+/).filter(Boolean));
  expect(emitted).toEqual([
    { text: 'One', start: 0.1, end: 0.16 },
    { text: 'two', start: 0.3, end: 0.35 },
    { text: 'three', start: 0.4, end: 0.49 },
  ]);
});

function batchFor(received: string, start = 0, step = 0.1) {
  const characters = [...received];
  return {
    characters,
    starts: characters.map((_, index) => Number((start + index * step).toFixed(3))),
    ends: characters.map((_, index) => Number((start + index * step + 0.05).toFixed(3))),
  };
}

function wordsFor(expected: string, received: string) {
  const accumulator = createWordTimingAccumulator(expected);
  return [...accumulator.append(batchFor(received)), ...accumulator.flush()];
}

// Soniox does not promise to echo the article byte for byte: it may read a
// newline as a space, fold a curly quote, or skip a symbol it cannot say. The
// word text always comes from the article, and the characters Soniox sends
// only supply the times, so every rendered word still gets a timing.
test.each([
  ['substituted character', 'Hello world', 'Hxllo world'],
  ['normalised quote', 'It’s “fine”', "It's \"fine\""],
  ['missing whitespace', 'Hello world', 'Helloworld'],
  ['normalised whitespace', 'Hello\nworld', 'Hello world'],
  ['no-break space', 'Hello\u00a0world', 'Hello world'],
  ['duplicated character', 'Hello world', 'Helloo world'],
  ['inserted whitespace', 'Hello world', 'Hel lo world'],
  ['reordered characters', 'Hello world', 'Hlelo world'],
  ['dropped soft hyphen', 'Hel\u00adlo world', 'Hello world'],
  ['dropped zero-width space', 'Hello\u200b world', 'Hello world'],
  ['dropped punctuation', 'Hello — world', 'Hello world'],
  ['dropped trailing punctuation', 'Hello world.”', 'Hello world'],
  ['expanded symbol', 'Hello & world', 'Hello and world'],
  ['extra trailing characters', 'Hello world', 'Hello world!!'],
])('aligns a %s to the article and still emits every rendered word', (_name, expected, received) => {
  const words = wordsFor(expected, received);
  expect(words.map((word) => word.text)).toEqual(expected.split(/\s+/).filter(Boolean));
  let previousEnd = 0;
  for (const word of words) {
    expect(word.start).toBeGreaterThanOrEqual(previousEnd);
    expect(word.end).toBeGreaterThan(word.start);
    previousEnd = word.end;
  }
});

test('a substituted character keeps the voiced time; a word Soniox skipped gets its own slot', () => {
  expect(wordsFor('Hello world', 'Hxllo world')).toEqual([
    { text: 'Hello', start: 0, end: 0.45 },
    { text: 'world', start: 0.6, end: 1.05 },
  ]);
  // "—" is never voiced: it lands right after "Hello" and "world" follows it.
  expect(wordsFor('Hello — world', 'Hello world')).toEqual([
    { text: 'Hello', start: 0, end: 0.45 },
    { text: '—', start: 0.45, end: 0.451 },
    { text: 'world', start: 0.6, end: 1.05 },
  ]);
});

test('a multi-code-point entry shares one timing across its characters', () => {
  const accumulator = createWordTimingAccumulator('e\u0301a b');
  const words = [
    ...accumulator.append({ characters: ['e\u0301', 'a', ' ', 'b'], starts: [0, 0.1, 0.2, 0.3], ends: [0.05, 0.15, 0.25, 0.35] }),
    ...accumulator.flush(),
  ];
  expect(words).toEqual([
    { text: 'e\u0301a', start: 0, end: 0.15 },
    { text: 'b', start: 0.3, end: 0.35 },
  ]);
});

test('rejects an empty character entry', () => {
  const accumulator = createWordTimingAccumulator('A');
  expect(() => accumulator.append({ characters: [''], starts: [0], ends: [0.1] })).toThrow(/non-character/i);
});

test('rejects incomplete final character consumption when the stream terminates', () => {
  const accumulator = createWordTimingAccumulator('Exact timing');
  const characters = [...'Exact'];
  accumulator.append({
    characters,
    starts: characters.map((_, index) => index * 0.1),
    ends: characters.map((_, index) => index * 0.1 + 0.05),
  });

  expect(() => accumulator.flush()).toThrow(/incomplete .*character stream/i);
});

test('rejects non-finite, negative, reversed, and globally non-monotonic character times', () => {
  const invalidBatches = [
    { characters: ['A'], starts: [Number.NaN], ends: [0.1] },
    { characters: ['A'], starts: [-0.1], ends: [0.1] },
    { characters: ['A'], starts: [0.2], ends: [0.1] },
  ];

  for (const batch of invalidBatches) {
    const accumulator = createWordTimingAccumulator('A');
    expect(() => accumulator.append(batch)).toThrow(/timestamp/i);
  }

  const accumulator = createWordTimingAccumulator('AB');
  accumulator.append({ characters: ['A'], starts: [0.2], ends: [0.3] });
  expect(() =>
    accumulator.append({ characters: ['B'], starts: [0.1], ends: [0.4] })
  ).toThrow(/monotonic/i);
});
