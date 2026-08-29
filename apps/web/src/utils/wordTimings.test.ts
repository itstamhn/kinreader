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
      characters: ['w'],
      starts: [0.3],
      ends: [0.31],
    })
  ).toEqual([]);
  expect(
    accumulator.flush()
  ).toEqual([{ text: 'world', start: 0.3, end: 0.31 }]);
});

test('does not use leading or whitespace-only batch timestamps as a word start', () => {
  const accumulator = createWordTimingAccumulator('A B');

  expect(
    accumulator.append({
      characters: [' ', 'A'],
      starts: [0, 0.12],
      ends: [0.1, 0.2],
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
  const text = '  One\n two   three ';
  const accumulator = createWordTimingAccumulator(text);
  const emitted = [
    ...accumulator.append({
      characters: [' ', ' '],
      starts: [0, 0.01],
      ends: [0.005, 0.015],
    }),
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
