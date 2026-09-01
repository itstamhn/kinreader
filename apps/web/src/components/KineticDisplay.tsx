import React, { useMemo } from 'react';
import type { WordTiming } from '../types';

interface KineticDisplayProps {
  words: WordTiming[];
  currentWordIndex: number;
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
  const cards = segmentClauses(words, clauseLength);
  if (cards.length === 0) return null;
  let active = cards.findIndex((c) => wordIndex >= c.startIndex && wordIndex <= c.endIndex);
  if (active === -1) active = 0;
  const target = cards[active + direction];
  return target ? target.startIndex : null;
}

export function KineticDisplay({
  words,
  currentWordIndex,
  onSelectWord,
  viewMode,
  fontSize = 'md',
  clauseLength = 6,
  emptyMessage,
}: KineticDisplayProps) {
  const cards = useMemo(() => segmentClauses(words, clauseLength), [words, clauseLength]);

  // Find active clause index
  const activeCardIndex = useMemo(() => {
    const idx = cards.findIndex(
      (c) => currentWordIndex >= c.startIndex && currentWordIndex <= c.endIndex
    );
    return idx !== -1 ? idx : 0;
  }, [cards, currentWordIndex]);

  const activeCard = cards[activeCardIndex] || cards[0];
  const prevCard2 = activeCardIndex > 1 ? cards[activeCardIndex - 2] : null;
  const prevCard1 = activeCardIndex > 0 ? cards[activeCardIndex - 1] : null;
  const nextCard1 = activeCardIndex < cards.length - 1 ? cards[activeCardIndex + 1] : null;

  if (!words || words.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-[#ECEAE4]/40">
        <p className="text-sm font-sans">{emptyMessage ?? 'No article loaded. Paste a URL or select from library.'}</p>
      </div>
    );
  }

  // Font sizing styles based on preferences
  const activeFontSize = {
    sm: 'text-[32px] sm:text-[40px] lg:text-[42px]',
    md: 'text-[34px] sm:text-[44px] lg:text-[46px]',
    lg: 'text-[38px] sm:text-[48px] lg:text-[52px]',
  }[fontSize];

  // 1. Left-Aligned Typographic Cadence
  if (viewMode === 'kinetic') {
    return (
      <div className="flex-1 flex flex-col justify-center items-start px-6 sm:px-16 select-none max-w-4xl mx-auto w-full relative min-h-0 text-left">
        <div className="w-full flex flex-col items-start justify-center gap-5 sm:gap-6">
          {/* Slot 1: Past Clause 2 (font: 300 24px/1.35 Newsreader, opacity 16%) */}
          <div className="w-full h-8 flex items-center justify-start overflow-hidden">
            {prevCard2 ? (
              <div
                onClick={() => onSelectWord(prevCard2.startIndex)}
                title="Tap to re-read from here"
                className="font-serif font-light text-[18px] sm:text-[22px] lg:text-[24px] leading-[1.35] text-[#ECEAE4]/16 hover:text-[#ECEAE4]/60 cursor-pointer transition-all duration-200 text-left max-w-[760px] text-pretty truncate"
              >
                {prevCard2.words.map((w) => w.text).join(' ')}
              </div>
            ) : (
              <div className="h-full pointer-events-none opacity-0" aria-hidden="true">
                &nbsp;
              </div>
            )}
          </div>

          {/* Slot 2: Past Clause 1 (font: 300 24px/1.35 Newsreader, opacity 32%) */}
          <div className="w-full h-8 flex items-center justify-start overflow-hidden">
            {prevCard1 ? (
              <div
                onClick={() => onSelectWord(prevCard1.startIndex)}
                title="Tap to re-read from here"
                className="font-serif font-light text-[19px] sm:text-[22px] lg:text-[24px] leading-[1.35] text-[#ECEAE4]/32 hover:text-[#ECEAE4]/75 cursor-pointer transition-all duration-200 text-left max-w-[760px] text-pretty truncate"
              >
                {prevCard1.words.map((w) => w.text).join(' ')}
              </div>
            ) : (
              <div className="h-full pointer-events-none opacity-0" aria-hidden="true">
                &nbsp;
              </div>
            )}
          </div>

          {/* Slot 3: Center Focal Active Clause (font: 400 46px/1.2 Newsreader, letter-spacing: -.01em) */}
          <div className="w-full min-h-[76px] sm:min-h-[110px] flex items-center justify-start overflow-visible relative my-1">
            <div
              key={activeCard?.id ?? 0}
              className={`w-full font-serif font-normal ${activeFontSize} leading-[1.2] tracking-[-0.01em] text-pretty max-w-[760px] text-left transition-all duration-150`}
            >
              {activeCard?.words.map((word, idx) => {
                const globalIdx = activeCard.startIndex + idx;
                const isActive = globalIdx === currentWordIndex;
                const isPast = globalIdx < currentWordIndex;

                return (
                  <span
                    key={`${activeCard.id}-${idx}-${word.text}`}
                    onClick={() => onSelectWord(globalIdx)}
                    className={`inline-block cursor-pointer mr-2 sm:mr-3 select-none transition-all duration-150 ${
                      isActive
                        ? 'text-[#FFF7EA] word-active-luminous font-medium scale-[1.02]'
                        : isPast
                        ? 'text-[rgba(240,238,232,0.9)]'
                        : 'text-[rgba(236,234,228,0.55)] hover:text-[#ECEAE4]/80'
                    }`}
                    style={{
                      textShadow: isActive
                        ? '0 0 26px rgba(242,163,60,0.55), 0 0 8px rgba(242,163,60,0.85)'
                        : 'none',
                    }}
                  >
                    {word.text}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Slot 4: Next Clause Preview (font: 300 24px/1.35 Newsreader, opacity 14%) */}
          <div className="w-full h-8 flex items-center justify-start overflow-hidden">
            {nextCard1 ? (
              <div
                onClick={() => onSelectWord(nextCard1.startIndex)}
                className="font-serif font-light text-[18px] sm:text-[22px] lg:text-[24px] leading-[1.35] text-[#ECEAE4]/14 hover:text-[#ECEAE4]/50 cursor-pointer transition-all duration-200 text-left max-w-[760px] text-pretty truncate"
              >
                {nextCard1.words.map((w) => w.text).join(' ')}
              </div>
            ) : (
              <div className="h-full pointer-events-none opacity-0" aria-hidden="true">
                &nbsp;
              </div>
            )}
          </div>
        </div>

        {/* Keyboard Interaction Subtitle Hint */}
        <div className="absolute bottom-3 font-mono text-[10px] text-[#ECEAE4]/30 pointer-events-none hidden sm:block">
          Space play · ←→ clauses · ↑↓ tempo · tap dimmed lines to re-read
        </div>
      </div>
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
              className={`cursor-pointer transition-all duration-100 mr-2 inline-block ${
                isActive
                  ? 'bg-[#F2A33C]/20 text-[#FFF7EA] font-semibold rounded px-1.5 py-0.5 shadow-md word-active-luminous border border-[#F2A33C]/40'
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
