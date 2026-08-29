import React, { useMemo } from 'react';
import type { WordTiming } from '../types';

interface KineticDisplayProps {
  words: WordTiming[];
  currentWordIndex: number;
  onSelectWord: (index: number) => void;
  viewMode: 'kinetic' | 'full';
  fontSize?: 'sm' | 'md' | 'lg';
  clauseLength?: 4 | 6 | 9;
}

interface RhythmicCard {
  id: number;
  startIndex: number;
  endIndex: number;
  words: WordTiming[];
}

export function KineticDisplay({
  words,
  currentWordIndex,
  onSelectWord,
  viewMode,
  fontSize = 'md',
  clauseLength = 6,
}: KineticDisplayProps) {
  // Advanced Syntactic & Ergonomic Clause Segmentation (Single-Line RSVP Glance)
  const cards = useMemo(() => {
    if (!words || words.length === 0) return [];
    const result: RhythmicCard[] = [];
    let cur: WordTiming[] = [];
    let startIdx = 0;
    let curCharLen = 0;

    // Target constraints based on clauseLength setting (4 = Short, 6 = Flow, 9 = Long)
    const targetWords = clauseLength;
    const maxCharsPerLine = clauseLength <= 4 ? 32 : clauseLength <= 6 ? 44 : 56;

    const SYNTACTIC_CONNECTORS = new Set([
      'and', 'or', 'but', 'nor', 'for', 'yet', 'so',
      'because', 'although', 'since', 'unless', 'while', 'whereas',
      'that', 'which', 'who', 'whom', 'whose', 'where', 'when',
      'with', 'without', 'through', 'into', 'under', 'between'
    ]);

    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      const text = w.text.trim();
      const cleanWord = text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const hasTerminalPunct = /[.!?]$/.test(text);
      const hasClausePunct = /[,;:]$/.test(text) || text.includes('—') || text.includes('–');

      // Check if we should break before a syntactic connector
      const isNextWordConnector = i < words.length - 1 && SYNTACTIC_CONNECTORS.has(
        words[i + 1]!.text.trim().replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
      );

      cur.push(w);
      curCharLen += text.length + 1;

      const isLongEnough = cur.length >= Math.max(2, targetWords - 2);
      const isOverWordTarget = cur.length >= targetWords;
      const isOverCharLimit = curCharLen >= maxCharsPerLine;

      let shouldBreak = false;

      // 1. Terminal sentence break (period, exclamation, question mark)
      if (hasTerminalPunct) {
        shouldBreak = true;
      }
      // 2. Natural punctuation break (comma, semicolon, dash) if at least 2 words
      else if (hasClausePunct && (isLongEnough || curCharLen >= 20)) {
        shouldBreak = true;
      }
      // 3. Syntactic boundary split (before "and", "because", "that") if sufficient length
      else if (isNextWordConnector && (isLongEnough || curCharLen >= 26)) {
        shouldBreak = true;
      }
      // 4. Character / Word capacity ceiling (Guarantees no multi-line wrapping jitter)
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
  }, [words, clauseLength]);

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
        <p className="text-sm font-sans">No article loaded. Paste a URL or select from library.</p>
      </div>
    );
  }

  // Font sizing styles based on preferences
  const fontSizeClasses = {
    sm: 'text-[26px] sm:text-[36px] lg:text-[40px]',
    md: 'text-[30px] sm:text-[42px] lg:text-[46px]',
    lg: 'text-[34px] sm:text-[48px] lg:text-[52px]',
  }[fontSize];

  // 1. Stable Left-Aligned Fixed-Baseline Kinetic Reading Experience (Zero Eye Wandering)
  if (viewMode === 'kinetic') {
    return (
      <div className="flex-1 flex flex-col justify-center items-start px-6 sm:px-14 select-none max-w-4xl mx-auto w-full relative min-h-0">
        <div className="w-full flex flex-col items-start gap-2.5 sm:gap-3.5">
          {/* Slot 1: Past Clause 2 (Fixed height: 30px, 18% opacity, Left Aligned) */}
          <div className="w-full h-7 sm:h-8 flex items-center justify-start overflow-hidden">
            {prevCard2 ? (
              <div
                onClick={() => onSelectWord(prevCard2.startIndex)}
                title="Tap to re-read from here"
                className="font-serif font-light text-[16px] sm:text-[19px] leading-tight text-[#ECEAE4]/20 hover:text-[#ECEAE4]/60 cursor-pointer transition-all duration-200 truncate text-left max-w-3xl"
              >
                {prevCard2.words.map((w) => w.text).join(' ')}
              </div>
            ) : (
              <div className="h-full pointer-events-none opacity-0" aria-hidden="true">
                &nbsp;
              </div>
            )}
          </div>

          {/* Slot 2: Past Clause 1 (Fixed height: 30px, 35% opacity, Left Aligned) */}
          <div className="w-full h-7 sm:h-8 flex items-center justify-start overflow-hidden">
            {prevCard1 ? (
              <div
                onClick={() => onSelectWord(prevCard1.startIndex)}
                title="Tap to re-read from here"
                className="font-serif font-light text-[17px] sm:text-[20px] leading-tight text-[#ECEAE4]/35 hover:text-[#ECEAE4]/75 cursor-pointer transition-all duration-200 truncate text-left max-w-3xl"
              >
                {prevCard1.words.map((w) => w.text).join(' ')}
              </div>
            ) : (
              <div className="h-full pointer-events-none opacity-0" aria-hidden="true">
                &nbsp;
              </div>
            )}
          </div>

          {/* Slot 3: Fixed Optical Baseline Focal Stage (Left Aligned Fixed Starting Guide) */}
          <div className="w-full h-[72px] sm:h-[90px] flex items-center justify-start overflow-visible relative">
            <div
              key={activeCard?.id ?? 0}
              className={`w-full font-serif font-normal ${fontSizeClasses} leading-none tracking-[-0.015em] text-nowrap whitespace-nowrap overflow-visible max-w-4xl flex items-center justify-start flex-nowrap text-left transition-all duration-150`}
            >
              {activeCard?.words.map((word, idx) => {
                const globalIdx = activeCard.startIndex + idx;
                const isActive = globalIdx === currentWordIndex;
                const isPast = globalIdx < currentWordIndex;

                return (
                  <span
                    key={`${activeCard.id}-${idx}-${word.text}`}
                    onClick={() => onSelectWord(globalIdx)}
                    className={`inline-block cursor-pointer mr-2.5 sm:mr-3 select-none transform shrink-0 ${
                      isActive
                        ? 'text-[#FFF7EA] font-medium scale-[1.02] word-active-luminous'
                        : isPast
                        ? 'text-[rgba(240,238,232,0.92)]'
                        : 'text-[rgba(236,234,228,0.4)] hover:text-[#ECEAE4]/80'
                    }`}
                    style={{
                      textShadow: isActive ? '0 0 26px rgba(242,163,60,0.6)' : 'none',
                      transition: 'color .12s, text-shadow .12s, transform .12s',
                    }}
                  >
                    {word.text}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Slot 4: Next Clause Preview (Fixed height: 30px, 16% opacity, Left Aligned) */}
          <div className="w-full h-7 sm:h-8 flex items-center justify-start overflow-hidden">
            {nextCard1 ? (
              <div
                onClick={() => onSelectWord(nextCard1.startIndex)}
                className="font-serif font-light text-[17px] sm:text-[20px] leading-tight text-[#ECEAE4]/18 hover:text-[#ECEAE4]/50 cursor-pointer transition-all duration-200 truncate text-left max-w-3xl"
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
        <div className="absolute bottom-3 left-6 sm:left-14 font-mono text-[10.5px] text-[#ECEAE4]/30 pointer-events-none hidden sm:block">
          Space play · ←→ clauses (tap dimmed lines to re-read) · ↑↓ tempo
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
