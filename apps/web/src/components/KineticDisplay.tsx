import React, { useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import type { WordTiming } from '../types';
import { editorialPages, editorialPageAtTime, type EditorialLayout } from '../utils/editorialPages';

interface KineticDisplayProps {
  words: WordTiming[];
  isFetching?: boolean;
  isPending?: boolean;
  articleText?: string;
  onTogglePlay?: () => void;
  onPageChange?: (page: { number: number; count: number }) => void;
  currentWordIndex: number;
  currentTime: number;
  onSelectWord: (index: number, startPlayback?: boolean) => void;
  viewMode: 'kinetic' | 'full';
  fontSize?: 'sm' | 'md' | 'lg';
  theme?: 'dark' | 'light';
  /** Shown instead of the default hint while the word list is empty. */
  emptyMessage?: string;
}

export function KineticDisplay({
  words,
  isFetching = false,
  isPending = false,
  articleText,
  onTogglePlay,
  onPageChange,
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
  const fullTextRef = useRef<HTMLDivElement>(null);
  const revealedFullText = useRef(false);
  useLayoutEffect(() => {
    if (viewMode !== 'full' || isFetching || !words.length) {
      revealedFullText.current = false;
      return;
    }
    if (revealedFullText.current || isPending) return;
    const activeWord = fullTextRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!activeWord) return;
    // Reveal the listening position on entry, then leave manual scrolling alone.
    activeWord.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    revealedFullText.current = true;
  }, [viewMode, isFetching, isPending, words.length, currentWordIndex]);
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
        maxWidth: Math.max(1, stage.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - 4),
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

  useEffect(() => { onPageChange?.({ number: page ? activePageIndex + 1 : 0, count: pages.length }); }, [activePageIndex, pages.length, !!page, onPageChange]);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);

  useEffect(() => {
    const handlePageKey = (event: KeyboardEvent) => {
      if (document.querySelector('[role=dialog]')) return;
      if (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight') return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable], [role=slider], [role=menu]')) return;
      event.preventDefault();
      const next = pages[activePageIndex + (event.code === 'ArrowLeft' ? -1 : 1)];
      if (next) onSelectWord(next.startIndex);
    };
    window.addEventListener('keydown', handlePageKey);
    return () => window.removeEventListener('keydown', handlePageKey);
  }, [pages, activePageIndex, onSelectWord]);

  const paragraphs = useMemo(() => {
    if (!articleText) return [words.map((_, index) => index)];
    const sourceParagraphs = articleText.trim().split(/\n\s*\n/).map(text => text.split(/\s+/).filter(Boolean));
    const sourceWords = sourceParagraphs.flat();
    if (!words.every((word, index) => word.text === sourceWords[index])) return [words.map((_, index) => index)];
    let offset = 0;
    return sourceParagraphs.flatMap(paragraph => {
      const start = offset;
      offset += paragraph.length;
      return start < words.length ? [Array.from({ length: Math.min(offset, words.length) - start }, (_, index) => start + index)] : [];
    });
  }, [articleText, words]);

  if (isFetching) {
    return <div className="reader-fetching" role="status">
      <p>Fetching the article…</p><span>Usually a few seconds</span>
    </div>;
  }

  if (words.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-[#ECEAE4]/40">
        <p className="text-sm font-sans">{emptyMessage ?? 'No article loaded. Paste a URL or select from library.'}</p>
      </div>
    );
  }

  if (viewMode === 'kinetic' && page) {
    return (
      <section className="editorial-reader" data-reader-theme={theme} aria-label="Kinetic reading page"
        onPointerDown={e => { gesture.current = { x: e.clientX, y: e.clientY }; swiped.current = false; }}
        onPointerCancel={() => { gesture.current = null; }}
        onPointerUp={e => {
          if (!gesture.current) return;
          const dx = e.clientX - gesture.current.x;
          const dy = e.clientY - gesture.current.y;
          gesture.current = null;
          if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            swiped.current = true;
            const next = pages[activePageIndex + (dx < 0 ? 1 : -1)];
            if (next) onSelectWord(next.startIndex);
          }
        }}
        onClickCapture={e => { if (swiped.current) { e.stopPropagation(); e.preventDefault(); swiped.current = false; } }}
        onClick={e => { if (!(e.target as HTMLElement).closest('button')) onTogglePlay?.(); }}>
        <div ref={stageRef} className="editorial-stage" style={{ '--editorial-size': `${(compact ? { sm: 30, md: 34, lg: 38 } : { sm: 46, md: 54, lg: 62 })[fontSize]}px` } as React.CSSProperties}>
          <div className="editorial-page" key={page.startIndex} data-page-start={page.startIndex}>
            {page.lines.map((line, row) => (
              <div className="editorial-line" key={row}>
                {line.map((index, position) => (
                  <React.Fragment key={index}>
                    {position > 0 ? ' ' : null}
                    <button
                      type="button"
                      className={`editorial-word ${!isPending && index <= currentWordIndex ? 'is-spoken' : ''}`}
                      aria-current={!isPending && index === currentWordIndex ? 'true' : undefined}
                      onClick={() => onSelectWord(index)}
                      title="Read from this word"
                    >{words[index]!.text}</button>
                  </React.Fragment>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <div ref={fullTextRef} className="reader-full-text" aria-label="Full article text" tabIndex={0}>
      {paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>
        {paragraph.map((index, position) => <React.Fragment key={index}>
          {position > 0 ? ' ' : null}
          <button type="button" onClick={() => onSelectWord(index, true)} title="Play from this word"
            aria-current={!isPending && index === currentWordIndex ? 'true' : undefined}
            className={`reader-full-word ${isPending ? 'reader-full-pending' : index === currentWordIndex
              ? 'reader-full-active' : index < currentWordIndex ? 'reader-full-past' : 'reader-full-pending'}`}>
            {words[index]!.text}
          </button>
        </React.Fragment>)}
      </p>)}
    </div>
  );
}
