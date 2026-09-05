import { describe, expect, test } from 'bun:test';
import { NARRATION_SECTION_CHARS, NARRATION_OPENING_SECTION_CHARS, planNarrationSections } from './durableNarration';

describe('planNarrationSections', () => {
  test('uses gradually growing opening targets and preserves every word', () => {
    const text = Array.from({ length: 500 }, (_, index) => `word${index}`).join(' ');
    const sections = planNarrationSections(text);
    sections.slice(0, NARRATION_OPENING_SECTION_CHARS.length).forEach((section, index) => {
      expect(section.length).toBeLessThanOrEqual(NARRATION_OPENING_SECTION_CHARS[index]!);
      if (index < sections.length - 1) expect(section.length).toBeGreaterThan(NARRATION_OPENING_SECTION_CHARS[index]! - 20);
    });
    expect(sections.slice(NARRATION_OPENING_SECTION_CHARS.length).every(section => section.length <= NARRATION_SECTION_CHARS)).toBe(true);
    expect(sections.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
  });

  test('handles short text and normalizes boundary whitespace', () => {
    expect(planNarrationSections('  hello\n\tworld  ')).toEqual(['hello\n\tworld']);
    expect(planNarrationSections(' \n ')).toEqual([]);
  });

  test('keeps internal paragraph whitespace and prefers a nearby sentence ending', () => {
    const first = `${'word '.repeat(24)}done.`;
    const text = `${first}\n\n${'next '.repeat(80)}`;
    const sections = planNarrationSections(text);
    expect(sections[0]).toBe(first);
    expect(sections.join(' ').split(/\s+/)).toEqual(text.trim().split(/\s+/));
  });

  test('keeps an indivisible long token and surrogate pairs intact', () => {
    const token = `https://example.test/${'界😀'.repeat(400)}`;
    expect(planNarrationSections(`${token} tail`)).toEqual([token, 'tail']);
    expect(planNarrationSections(`${token} tail`).join(' ').split(/\s+/)).toEqual([token, 'tail']);
  });
});
