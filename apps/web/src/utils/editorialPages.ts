import type { WordTiming } from '../types';

export interface EditorialPage {
  startIndex: number;
  endIndex: number;
  lines: number[][];
}

/** Text alone determines page and line boundaries. Incoming audio timings and
 * the active word never change the layout of an existing page. */
export interface EditorialLayout {
  maxWidth: number;
  measureText: (text: string) => number;
}

export function editorialPages(words: WordTiming[], maxCharacters = Infinity, layout?: EditorialLayout): EditorialPage[] {
  if (layout) return measuredPages(words, layout);
  const pages: EditorialPage[] = [];
  let start = 0;
  let characters = 0;
  for (let i = 0; i < words.length; i++) {
    const count = i - start + 1;
    const text = words[i]!.text;
    characters += text.length + (count > 1 ? 1 : 0);
    if ((count >= 10 && /[.!?]["'”’)]*$/.test(text)) ||
        (count >= 12 && /[,;:]["'”’)]*$/.test(text)) || count >= 18 || characters + (words[i + 1]?.text.length ?? 0) + 1 > maxCharacters || i === words.length - 1) {
      pages.push({ startIndex: start, endIndex: i, lines: balanceLines(words, start, i + 1, Number.isFinite(maxCharacters)) });
      start = i + 1;
      characters = 0;
    }
  }
  return pages;
}

function balanceLines(words: WordTiming[], start: number, end: number, compact: boolean): number[][] {
  const indices = Array.from({ length: end - start }, (_, i) => start + i);
  const length = (a: number, b: number) => words.slice(a, b).reduce((n, w) => n + w.text.length + 1, -1);
  const total = length(start, end);
  const rows = Math.min(indices.length, total <= (compact ? 25 : 32) ? 1 : total <= (compact ? 50 : 64) ? 2 : 3);
  let best: number[][] = [indices];
  let bestCost = Infinity;
  function split(from: number, remaining: number, lines: number[][], cost: number) {
    if (remaining === 0) {
      if (from === end && cost < bestCost) { best = lines; bestCost = cost; }
      return;
    }
    for (let to = remaining === 1 ? end : from + 1; to <= end - remaining + 1; to++) {
      const width = length(from, to);
      split(to, remaining - 1, [...lines, Array.from({ length: to - from }, (_, i) => from + i)], cost + (width - total / rows) ** 2);
    }
  }
  split(start, rows, [], 0);
  return best;
}

/** Add words at the chosen font size until three lines are full. Font size
 * never depends on page contents. An oversized token gets its own page and
 * wraps in CSS, so URLs cannot force the whole article into tiny type. */
function measuredPages(words: WordTiming[], layout: EditorialLayout): EditorialPage[] {
  const pages: EditorialPage[] = [];
  let start = 0;
  while (start < words.length) {
    const lines: number[][] = [[]];
    let end = start;
    for (; end < words.length && end < start + 18; end++) {
      if (end > start && layout.measureText(words[end]!.text) > layout.maxWidth) break;
      const line = lines.at(-1)!;
      const candidate = [...line, end].map(i => words[i]!.text).join(' ');
      if (layout.measureText(candidate) > layout.maxWidth && line.length) {
        if (lines.length === 3) break;
        lines.push([]);
      }
      lines.at(-1)!.push(end);
      const count = end - start + 1;
      const text = words[end]!.text;
      if (layout.measureText(text) > layout.maxWidth ||
          (count >= 10 && /[.!?]["'”’)]*$/.test(text)) ||
          (count >= 12 && /[,;:]["'”’)]*$/.test(text))) { end++; break; }
    }
    pages.push({ startIndex: start, endIndex: end - 1, lines });
    start = end;
  }
  return pages;
}

export function editorialPageAtTime(pages: EditorialPage[], words: WordTiming[], time: number): number {
  let low = 1, high = pages.length - 1, active = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const previous = words[pages[mid - 1]!.endIndex]!;
    const next = words[pages[mid]!.startIndex]!;
    const boundary = Math.min(next.start, (previous.end + next.start) / 2);
    if (time >= boundary) { active = mid; low = mid + 1; } else high = mid - 1;
  }
  return active;
}
