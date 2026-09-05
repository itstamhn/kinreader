import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

const ChromeContext = createContext(true);
export const useReaderChrome = () => useContext(ChromeContext);

/** Playback owns the idle timeout; pointer activity temporarily reveals the controls. */
export function ReaderFrame({ isPlaying, theme, children, hintAvailable = true }: {
  isPlaying: boolean;
  theme: 'dark' | 'light';
  hintAvailable?: boolean;
  children: React.ReactNode;
}) {
  const [chromeVisible, setChromeVisible] = useState(true);
  const [hintDismissed, setHintDismissed] = useState(() => {
    try { return localStorage.getItem('kinreader_hint_seen') === '1'; } catch { return false; }
  });
  const frame = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimer = () => clearTimeout(timer.current);
  const scheduleHide = (delay: number) => {
    clearTimer();
    timer.current = setTimeout(() => {
      // Keep open menus and keyboard-focused controls available until dismissed.
      if (frame.current?.querySelector('[data-reader-menu], .reader-fading :focus-visible, .reader-back:focus-visible')) {
        scheduleHide(3000);
        return;
      }
      setChromeVisible(false);
    }, delay);
  };
  useEffect(() => {
    setChromeVisible(true);
    if (isPlaying) { dismissHint(); scheduleHide(1500); }
    else clearTimer();
    return clearTimer;
  }, [isPlaying]);
  const reveal = () => {
    setChromeVisible(true);
    if (isPlaying) scheduleHide(3000);
  };
  const dismissHint = () => {
    try { localStorage.setItem('kinreader_hint_seen', '1'); } catch { /* Dismiss for this visit when storage is unavailable. */ }
    setHintDismissed(true);
  };
  const visible = !isPlaying || chromeVisible;
  return (
    <ChromeContext.Provider value={visible}>
      <div ref={frame} className="reader-frame" data-reader-theme={theme} data-chrome-visible={visible}
        onPointerMove={e => { if (e.pointerType !== 'touch' && e.buttons === 0) reveal(); }} onClick={reveal}
        onFocusCapture={e => { if (e.target.matches(':focus-visible')) reveal(); }}>
        {children}
        {!hintDismissed && !isPlaying && hintAvailable && visible && (
          <div className="reader-hint" role="status">
            <span className="reader-hint-desktop">Space plays or pauses. Click any word to hear it again. ← → turn the page.</span>
            <span className="reader-hint-mobile">Tap the text to play or pause. Tap any word to hear it again. Swipe to turn the page.</span>
            <button onClick={dismissHint} aria-label="Dismiss reading hint">Got it</button>
          </div>
        )}
      </div>
    </ChromeContext.Provider>
  );
}
