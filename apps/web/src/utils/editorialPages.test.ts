import { expect, test } from 'bun:test';
import { editorialPages, editorialPageAtTime } from './editorialPages';
const timings = (text: string) => text.split(' ').map((text, index) => ({ text, start: index, end: index + .6 }));

test('editorial pages preserve every word exactly once, cap length, and keep line breaks independent of timing', () => {
  const words = timings('The reader follows a quiet voice through a small page of text. The words stay still while the narration moves naturally from one sentence to the next, and the next page appears when it is needed.');
  const pages = editorialPages(words);
  expect(pages.flatMap(page => page.lines.flat())).toEqual(words.map((_, i) => i));
  expect(pages.every(p => p.endIndex - p.startIndex < 18 && p.lines.length <= 3)).toBe(true);
  expect(pages[0]!.endIndex).toBe(11);
  expect(editorialPages(words.map(w => ({ ...w, start: w.start * 2, end: w.end * 2 })))).toEqual(pages);
});

test('page changes use the midpoint of the spoken pause and resolve backwards after rewind', () => {
  const words = timings(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
  const pages = editorialPages(words);
  words[17]!.end = 17.4;
  words[18]!.start = 18.6;
  expect(editorialPageAtTime(pages, words, 17.99)).toBe(0);
  expect(editorialPageAtTime(pages, words, 18)).toBe(1);
  expect(editorialPageAtTime(pages, words, 39)).toBe(2);
  expect(editorialPageAtTime(pages, words, 0)).toBe(0);
});

test('phone pages keep readable groups without losing words or making a page exceed the character budget', () => {
  const words = timings('You have likely accumulated a lot of bloated instructions as you worked to steer the models toward good outcomes. The same recording should remain easy to follow on a phone.');
  const pages = editorialPages(words, 76);
  expect(pages.flatMap(p => p.lines.flat())).toEqual(words.map((_, i) => i));
  expect(pages.every(p => words.slice(p.startIndex, p.endIndex + 1).map(w => w.text).join(' ').length <= 76)).toBe(true);
});

test('measured pages fit three lines at a fixed size and preserve every word', () => {
  const words = timings('Small words fit easily. Extraordinary typography requires considerably more horizontal room while reading a longer passage with the same selected font size. The reader should get fewer words per page instead of smaller letters.');
  const measureText = (text: string) => text.length * 12;
  const narrow = editorialPages(words, Infinity, { maxWidth: 210, measureText });
  const wide = editorialPages(words, Infinity, { maxWidth: 600, measureText });
  expect(narrow.length).toBeGreaterThan(wide.length);
  expect(narrow.flatMap(p => p.lines.flat())).toEqual(words.map((_, i) => i));
  for (const page of narrow) {
    expect(page.lines.length).toBeLessThanOrEqual(3);
    for (const line of page.lines) expect(measureText(line.map(i => words[i]!.text).join(' '))).toBeLessThanOrEqual(210);
  }
});

test('a token wider than the reader gets its own page without losing subsequent words', () => {
  const words = timings('short supercalifragilisticexpialidocious next words');
  const pages = editorialPages(words, Infinity, { maxWidth: 10, measureText: text => text.length });
  expect(pages.flatMap(p => p.lines.flat())).toEqual([0, 1, 2, 3]);
});
