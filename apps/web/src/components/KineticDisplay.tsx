import React, { useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import type { WordTiming } from '../types';
import { editorialPages, editorialPageAtTime, type EditorialLayout } from '../utils/editorialPages';

interface KineticDisplayProps {
  words: WordTiming[];
  currentWordIndex: number;
  currentTime: number;
  onSelectWord: (index: number) => void;
  viewMode: 'kinetic' | 'full';
  fontSize?: 'sm' | 'md' | 'lg';
  theme?: 'dark' | 'light';
  /** Shown instead of the default hint while the word list is empty. */
  emptyMessage?: string;
}

export function KineticDisplay({
  words,
  currentWordIndex,
  currentTime,
  onSelectWord,
  viewMode,
  fontSize = 'md',
  theme = 'dark',
  emptyMessage,
}: KineticDisplayProps) {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)');
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const stageRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<EditorialLayout>();
  const hasWords = words.length > 0;
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    let disposed = false;
    const measure = () => {
      if (disposed || stage.clientWidth <= 0) return;
      const style = getComputedStyle(stage);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = parseFloat(style.letterSpacing) || 0;
      const cache = new Map<string, number>();
      setLayout({
        maxWidth: Math.max(1, stage.clientWidth - 4),
        measureText: text => {
          let width = cache.get(text);
          if (width === undefined) {
            width = context.measureText(text).width + text.length * spacing;
            cache.set(text, width);
          }
          return width;
        },
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    document.fonts?.ready.then(measure);
    document.fonts?.addEventListener('loadingdone', measure);
    return () => {
      disposed = true;
      observer.disconnect();
      document.fonts?.removeEventListener('loadingdone', measure);
    };
  }, [fontSize, compact, viewMode, hasWords]);
  // Timing corrections do not affect the measured widths or line breaks.
  const pages = useMemo(() => editorialPages(words, compact ? 76 : Infinity, layout), [words, compact, layout]);
  const activePageIndex = editorialPageAtTime(pages, words, currentTime);
  const page = pages[activePageIndex];

  useEffect(() => {
    const handlePageKey = (event: KeyboardEvent) => {
      if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]')) return;
      event.preventDefault();
      const next = pages[activePageIndex + (event.code === 'ArrowLeft' ? -1 : 1)];
      if (next) onSelectWord(next.startIndex);
    };
    window.addEventListener('keydown', handlePageKey);
    return () => window.removeEventListener('keydown', handlePageKey);
  }, [pages, activePageIndex, onSelectWord]);

  if (words.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-[#ECEAE4]/40">
        <p className="text-sm font-sans">{emptyMessage ?? 'No article loaded. Paste a URL or select from library.'}</p>
      </div>
    );
  }

  if (viewMode === 'kinetic' && page) {
    return (
      <section className="editorial-reader" data-reader-theme={theme} aria-label="Kinetic reading page">
        <div className="editorial-page-count">{activePageIndex + 1} / {pages.length}</div>
        <div ref={stageRef} className="editorial-stage" style={{ '--editorial-size': `${(compact ? { sm: 26, md: 30, lg: 34 } : { sm: 40, md: 48, lg: 56 })[fontSize]}px` } as React.CSSProperties}>
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
