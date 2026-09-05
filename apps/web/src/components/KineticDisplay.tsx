import React, { useMemo, useState, useEffect } from 'react';
import type { WordTiming } from '../types';
import { editorialPages, editorialPageAtTime } from '../utils/editorialPages';

interface KineticDisplayProps {
  words: WordTiming[];
  currentWordIndex: number;
  currentTime?: number;
  onSelectWord: (index: number) => void;
  viewMode: 'kinetic' | 'full';
  fontSize?: 'sm' | 'md' | 'lg';
  clauseLength?: 4 | 6 | 9;
  /** Shown instead of the default hint while the word list is empty. */
  emptyMessage?: string;
}

export interface RhythmicCard {
  id: number;
  startIndex: number;
  endIndex: number;
  words: WordTiming[];
}

const SYNTACTIC_CONNECTORS = new Set([
  'and', 'or', 'but', 'nor', 'for', 'yet', 'so',
  'because', 'although', 'since', 'unless', 'while', 'whereas',
  'that', 'which', 'who', 'whom', 'whose', 'where', 'when',
  'with', 'without', 'through', 'into', 'under', 'between',
]);

const TERMINAL_PUNCT_REGEX = /[.!?]$/;
const CLAUSE_PUNCT_REGEX = /[,;:]|—|–/;

// Advanced Syntactic & Ergonomic Clause Segmentation. Module-level (not a
// hook) so the keyboard clause navigation in App.tsx segments with exactly
// the same rules the display renders -- one source of truth for "a clause".
export function segmentClauses(words: WordTiming[], clauseLength: 4 | 6 | 9 = 6): RhythmicCard[] {
  if (!words || words.length === 0) return [];
  const result: RhythmicCard[] = [];
  let cur: WordTiming[] = [];
  let startIdx = 0;
  let curCharLen = 0;

  // Target constraints based on clauseLength setting (4 = Short, 6 = Flow, 9 = Long)
  const targetWords = clauseLength;
  const maxCharsPerLine = clauseLength <= 4 ? 32 : clauseLength <= 6 ? 44 : 56;

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const text = w.text.trim();
    const hasTerminalPunct = TERMINAL_PUNCT_REGEX.test(text);
    const hasClausePunct = CLAUSE_PUNCT_REGEX.test(text);

    // Check if we should break before a syntactic connector
    const isNextWordConnector =
      i < words.length - 1 &&
      SYNTACTIC_CONNECTORS.has(
        words[i + 1]!.text.trim().replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
      );

    cur.push(w);
    curCharLen += text.length + 1;

    const isLongEnough = cur.length >= Math.max(2, targetWords - 2);
    const isOverWordTarget = cur.length >= targetWords;
    const isOverCharLimit = curCharLen >= maxCharsPerLine;

    let shouldBreak = false;

    // 1. Terminal sentence break
    if (hasTerminalPunct) {
      shouldBreak = true;
    }
    // 2. Natural punctuation break
    else if (hasClausePunct && (isLongEnough || curCharLen >= 20)) {
      shouldBreak = true;
    }
    // 3. Syntactic boundary split
    else if (isNextWordConnector && (isLongEnough || curCharLen >= 26)) {
      shouldBreak = true;
    }
    // 4. Capacity ceiling
    else if (isOverCharLimit || (isOverWordTarget && cur.length >= targetWords + 1)) {
      shouldBreak = true;
    }

    if (shouldBreak || i === words.length - 1) {
      result.push({
        id: result.length,
        startIndex: startIdx,
        endIndex: i,
        words: [...cur],
      });
      cur = [];
      startIdx = i + 1;
      curCharLen = 0;
    }
  }

  return result;
}

// The first word of the clause before/after the one containing `wordIndex`,
// or null at either end. Backs the ArrowLeft/ArrowRight shortcuts.
export function adjacentClauseStart(
  words: WordTiming[],
  wordIndex: number,
  direction: -1 | 1,
  clauseLength: 4 | 6 | 9 = 6
): number | null {
  const cards = editorialPages(words, typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches ? 76 : Infinity);
  if (cards.length === 0) return null;
  let active = cards.findIndex((c) => wordIndex >= c.startIndex && wordIndex <= c.endIndex);
  if (active === -1) active = 0;
  const target = cards[active + direction];
  return target ? target.startIndex : null;
}

export function KineticDisplay({
  words,
  currentWordIndex,
  currentTime,
  onSelectWord,
  viewMode,
  fontSize = 'md',
  clauseLength = 6,
  emptyMessage,
}: KineticDisplayProps) {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)');
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const textIdentity = words.map(word => word.text).join(' ');
  // Boundaries contain indices only; receiving more exact timestamps must not
  // repaginate the article or disturb the currently displayed lines.
  const pages = useMemo(() => editorialPages(words, compact ? 76 : Infinity), [textIdentity, compact]);
  const activePageIndex = editorialPageAtTime(pages, words, currentTime ?? words[currentWordIndex]?.start ?? 0);
  const page = pages[activePageIndex];

  if (!words || words.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-[#ECEAE4]/40">
        <p className="text-sm font-sans">{emptyMessage ?? 'No article loaded. Paste a URL or select from library.'}</p>
      </div>
    );
  }

  if (viewMode === 'kinetic' && page) {
    const longestLine = Math.max(...page.lines.map(line => line.reduce((length, index) => length + words[index]!.text.length + 1, -1)));
    return (
      <section className="editorial-reader" aria-label="Kinetic reading page">
        <div className="editorial-page-count">{activePageIndex + 1} / {pages.length}</div>
        <div className="editorial-stage" style={{ '--editorial-size': `${{ sm: 40, md: 48, lg: 56 }[fontSize]}px`, '--editorial-fit': `${180 / Math.max(1, longestLine)}cqw` } as React.CSSProperties}>
          <div className="editorial-page" key={page.startIndex} data-page-start={page.startIndex}>
            {page.lines.map((line, row) => (
              <div className="editorial-line" key={row}>
                {line.map((index, position) => (
                  <React.Fragment key={index}>
                    {position > 0 ? ' ' : null}
                    <button
                      type="button"
                      className={`editorial-word ${index <= currentWordIndex ? 'is-spoken' : ''}`}
                      aria-current={index === currentWordIndex ? 'true' : undefined}
                      onClick={() => onSelectWord(index)}
                      title="Read from this word"
                    >{words[index]!.text}</button>
                  </React.Fragment>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="editorial-navigation">
          <button type="button" disabled={activePageIndex === 0} onClick={() => onSelectWord(pages[activePageIndex - 1]!.startIndex)} aria-label="Previous reading page">←</button>
          <span>Space play · ←→ pages · tap a word to re-read</span>
          <button type="button" disabled={activePageIndex === pages.length - 1} onClick={() => onSelectWord(pages[activePageIndex + 1]!.startIndex)} aria-label="Next reading page">→</button>
        </div>
      </section>
    );
  }

  // 2. Full Article Mode
  return (
    <div className="flex-1 overflow-y-auto px-6 py-8 max-w-3xl mx-auto leading-relaxed text-lg sm:text-xl font-serif text-[#ECEAE4]/55 select-text">
      <div className="space-y-4 text-left">
        {words.map((word, idx) => {
          const isActive = idx === currentWordIndex;
          const isPast = idx < currentWordIndex;

          return (
            <span
              key={idx}
              onClick={() => onSelectWord(idx)}
              className={`cursor-pointer transition-colors duration-100 mr-2 inline-block ${
                isActive
                  ? 'bg-[#F2A33C]/20 text-[#FFF7EA] rounded'
                  : isPast
                  ? 'text-[#ECEAE4]/85'
                  : 'text-[#ECEAE4]/30 hover:text-[#ECEAE4]/60'
              }`}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}
