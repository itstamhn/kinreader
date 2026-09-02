import { test, expect } from 'bun:test';
import { MAX_NARRATION_CHARS, MAX_NARRATION_WORDS, narrationText, sanitiseNarration } from './limits';

test('invisible characters are removed and line endings normalised, visible text is untouched', () => {
  const soft = 'in\u00advisible'; // soft hyphen
  const marks = '\ufeffstart \u200bzero\u200c width\u200e mark';
  expect(sanitiseNarration(soft)).toBe('invisible');
  expect(sanitiseNarration(marks)).toBe('start zero width mark');
  expect(sanitiseNarration('one\r\ntwo\rthree\tfour')).toBe('one\ntwo\nthree\tfour');
  // Emoji sequences keep their joiner; accents come out composed.
  expect(sanitiseNarration('\u{1f468}\u200d\u{1f4bb}')).toBe('\u{1f468}\u200d\u{1f4bb}');
  expect(sanitiseNarration('e\u0301')).toBe('\u00e9');
  expect(sanitiseNarration('“Curly” — and… non\u00a0breaking')).toBe('“Curly” — and… non\u00a0breaking');
  expect(narrationText('  A soft\u00adhyphen.  ').text).toBe('A softhyphen.');
});

test('short articles pass through untouched', () => {
  const result = narrationText('  One sentence. Another one.  ');
  expect(result).toEqual({ text: 'One sentence. Another one.', truncated: false, totalWords: 4, narratedWords: 4 });
});

test('an article over the character ceiling is cut at a sentence end and flagged', () => {
  const sentence = 'This sentence has exactly eight words in it. ';
  const content = sentence.repeat(Math.ceil((MAX_NARRATION_CHARS * 1.5) / sentence.length));
  const result = narrationText(content);
  expect(result.truncated).toBe(true);
  expect(result.text.length).toBeLessThanOrEqual(MAX_NARRATION_CHARS);
  expect(result.text.endsWith('.')).toBe(true);
  expect(result.narratedWords).toBeLessThan(result.totalWords);
  expect(result.narratedWords).toBe(result.text.split(/\s+/).length);
});

test('an article over the word ceiling is cut even when its characters fit', () => {
  const content = Array.from({ length: MAX_NARRATION_WORDS + 500 }, () => 'ab').join(' '); // ~25k chars
  expect(content.length).toBeLessThan(MAX_NARRATION_CHARS);
  const result = narrationText(content);
  expect(result.truncated).toBe(true);
  expect(result.narratedWords).toBeLessThanOrEqual(MAX_NARRATION_WORDS);
  expect(result.totalWords).toBe(MAX_NARRATION_WORDS + 500);
});
