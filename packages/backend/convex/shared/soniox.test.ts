import { expect, test } from 'bun:test';
import { splitTextIntoSonioxChunks } from './soniox';

test('splitTextIntoSonioxChunks covers text beyond the REST fallback limit without dropping a token', () => {
  const text = Array.from({ length: 230 }, (_, index) => `word${index}`).join(' ');

  const chunks = splitTextIntoSonioxChunks(text);

  expect(chunks.every((chunk) => chunk.length <= 450)).toBe(true);
  expect(chunks.join('')).toBe(text);
  expect(chunks.at(-1)).toContain('word229');
});

test('splitTextIntoSonioxChunks preserves interior whitespace exactly across chunk boundaries', () => {
  const text = `  ${'alpha '.repeat(80)} beta\n\ngamma   delta  `;

  const chunks = splitTextIntoSonioxChunks(text, 37);

  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= 37)).toBe(true);
  expect(chunks.join('')).toBe(text.trim());
});

test('splitTextIntoSonioxChunks slices an unbroken token at the configured chunk boundary', () => {
  const text = 'x'.repeat(451);

  const chunks = splitTextIntoSonioxChunks(text);

  expect(chunks).toEqual(['x'.repeat(450), 'x']);
  expect(chunks.every((chunk) => chunk.length <= 450)).toBe(true);
  expect(chunks.join('')).toBe(text);
});
