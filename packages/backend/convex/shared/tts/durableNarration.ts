import type { WordTiming } from './wordTimings';

export const DURABLE_NARRATION_MAX_CHARS = 150000;
export const DURABLE_NARRATION_MAX_WORDS = 30000;
export const NARRATION_SECTION_CHARS = 650;
export const NARRATION_OPENING_SECTION_CHARS = [
  180, 180, 180, 180,
  220, 220, 220, 220,
  270, 270, 270, 270,
  330, 330, 410, 410, 510, 510,
] as const;
export const NARRATION_CONCURRENCY = 2;
export const NARRATION_LEASE_MS = 180000;

/**
 * Plans new narration sections from the same whitespace-token identity used by
 * timing validation. Targets grow gradually so the second request does not
 * replace the old startup wait with an immediate large-section gap. An
 * indivisible URL, CJK run, or other long token may exceed its target.
 */
export function planNarrationSections(text: string): string[] {
  const words = Array.from(text.matchAll(/\S+/gu), match => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }));
  if (words.length === 0) return [];
  const sections: string[] = [];
  let first = 0;
  while (first < words.length) {
    const target = NARRATION_OPENING_SECTION_CHARS[sections.length] ?? NARRATION_SECTION_CHARS;
    const sectionStart = words[first]!.start;
    let last = first;
    let preferred = -1;
    while (last + 1 < words.length && words[last + 1]!.end - sectionStart <= target) {
      last += 1;
      if (/[.!?]["')\]]?$/u.test(words[last]!.text) && words[last]!.end - sectionStart >= target * 0.6) preferred = last;
    }
    if (preferred >= first) last = preferred;
    sections.push(text.slice(sectionStart, words[last]!.end));
    first = last + 1;
  }
  return sections;
}
export interface NarrationPage {
  status: 'none' | 'running' | 'done' | 'failed';
  total: number;
  completed: number;
  error: string | null;
  sections: { index: number; audioUrl: string; duration: number; words: WordTiming[] }[];
}
