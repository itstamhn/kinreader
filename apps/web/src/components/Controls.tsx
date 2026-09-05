import React, { useState } from 'react';
import { LoadingRing } from './LoadingRing';
import { useReaderChrome } from './ReaderFrame';

interface ControlsProps {
  isPlaying: boolean;
  isFetching?: boolean;
  awaitingSavedRecording?: boolean;
  pageNumber?: number;
  pageCount?: number;
  onTogglePlay: () => void;
  speed: number;
  onSpeedChange: (speed: number) => void;
  progress: number;
  onSeekProgress: (percent: number) => void;
  currentTime: number;
  duration: number;
  remainingSeconds: number;
  sourceUrl?: string;
  sourceType?: 'x' | 'article' | 'text';
  viewMode?: 'kinetic' | 'full';
  onToggleViewMode?: () => void;
  isSynthesizing?: boolean;
  isPlayable?: boolean;
  isBuffering?: boolean;
  bufferedProgress?: number;
  loadingProgress?: { readySeconds: number; targetSeconds: number; waiting: boolean };
  isDegraded?: boolean;
  isError?: boolean;
  /** Overrides the default degraded-notice copy (e.g. REST audio with estimated word sync). */
  degradedMessage?: string;
  /** Overrides the default error-notice copy when playback itself is unavailable. */
  errorMessage?: string;
  /** A dismissible notice (e.g. an article that failed to load) that does not block playback. */
  noticeMessage?: string;
  onDismissNotice?: () => void;
  /** A neutral progress line (e.g. waiting for a pre-generated track). */
  infoMessage?: string;
  /** Show a spinner beside the info line (progress) rather than an info icon. */
  infoBusy?: boolean;
  /** An optional action on the info line (e.g. stop waiting and play now). */
  infoAction?: { label: string; onClick: () => void };
}

const SPEED_OPTIONS = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.1, 2.5, 3.0, 3.5];

export function Controls({
  isPlaying,
  isFetching = false,
  awaitingSavedRecording = false,
  pageNumber = 0,
  pageCount = 0,
  onTogglePlay,
  speed,
  onSpeedChange,
  progress,
  onSeekProgress,
  currentTime,
  duration,
  sourceUrl,
  viewMode = 'kinetic',
  onToggleViewMode,
  isSynthesizing = false,
  isPlayable = true,
  isBuffering = isSynthesizing,
  bufferedProgress,
  loadingProgress,
  isDegraded = false,
  isError = false,
  degradedMessage = 'Word highlighting is estimated for this article',
  errorMessage = 'Audio couldn’t be loaded',
  noticeMessage,
  onDismissNotice,
  infoMessage,
  infoAction,
}: ControlsProps) {
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [hoverSeek, setHoverSeek] = useState<number | null>(null);
  const chromeVisible = useReaderChrome();
  const waitingForAudio = !isFetching && !isError && !isPlaying &&
    (awaitingSavedRecording || (!isPlayable && (isBuffering || isSynthesizing)));
  const visible = chromeVisible || isFetching || waitingForAudio || isError || !!noticeMessage;
  const bufferPercent = Math.max(0, Math.min(100, loadingProgress?.waiting && loadingProgress.targetSeconds > 0
    ? loadingProgress.readySeconds / loadingProgress.targetSeconds * 100 : bufferedProgress ?? 0));

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return '00:00';
    const s = Math.floor(secs);
    const m = Math.floor(s / 60);
    const remainder = s % 60;
    return `${m.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
  };

  const safeSpeed = speed > 0 ? speed : 1.0;
  const handleSkip = (deltaSeconds: number) => {
    if (duration > 0) {
      const newTime = Math.max(0, Math.min(duration, currentTime + deltaSeconds * safeSpeed));
      onSeekProgress((newTime / duration) * 100);
    }
  };

  const handleTimelinePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}

    const updateSeek = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onSeekProgress(pos * 100);
    };

    updateSeek(e.clientX);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateSeek(moveEvent.clientX);
    };

    const handlePointerUp = () => {
      el.removeEventListener('pointermove', handlePointerMove);
      el.removeEventListener('pointerup', handlePointerUp);
      el.removeEventListener('pointercancel', handlePointerUp);
    };

    el.addEventListener('pointermove', handlePointerMove);
    el.addEventListener('pointerup', handlePointerUp);
    el.addEventListener('pointercancel', handlePointerUp);
  };

  const cycleSpeed = () => {
    const currentIndex = SPEED_OPTIONS.findIndex((s) => Math.abs(s - speed) < 0.05);
    const nextIndex = (currentIndex + 1) % SPEED_OPTIONS.length;
    onSpeedChange(SPEED_OPTIONS[nextIndex]!);
  };

  const playTitle = isError ? 'Audio unavailable' : isBuffering
    ? isPlaying ? 'Pause buffering (Space)' : 'Play when audio is ready'
    : isPlaying ? 'Pause (Space)' : 'Play (Space)';
  const play = (ghost = false) => (
    <button onClick={onTogglePlay} disabled={!isPlayable || isError}
      className={ghost ? 'reader-ghost-pause' : 'reader-play'} title={playTitle}>
      {isPlaying ? (
        <svg width={ghost ? 14 : 22} height={ghost ? 16 : 26} viewBox="0 0 22 26" aria-hidden="true">
          <rect x="3" y="2" width="5.5" height="22" rx="2.2" fill="currentColor" />
          <rect x="13.5" y="2" width="5.5" height="22" rx="2.2" fill="currentColor" />
        </svg>
      ) : <svg width="22" height="24" viewBox="0 0 12 14" style={{ transform: 'translateX(1px)' }} aria-hidden="true">
        <path d="M2 2v10c0 .8.9 1.3 1.6.9l8-5c.6-.4.6-1.4 0-1.8l-8-5C2.9.7 2 1.2 2 2z" fill="currentColor" />
      </svg>}
    </button>
  );
  const skip = (direction: number) => (
    <button className="reader-skip" onClick={() => handleSkip(direction * 15)}
      aria-label={direction < 0 ? 'Rewind 15 seconds' : 'Fast forward 15 seconds'}
      title={direction < 0 ? 'Rewind 15 seconds' : 'Fast forward 15 seconds'}>
      <svg width="26" height="26" viewBox="0 0 30 30" fill="none" style={{ transform: direction > 0 ? 'scaleX(-1)' : undefined }} aria-hidden="true">
        <path d="M15 4a11 11 0 1 1-8.6 4.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M6.5 2.5v6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg><span>15</span>
    </button>
  );
  const tempo = () => <button className="reader-tempo" onClick={() => setShowSpeedMenu(!showSpeedMenu)}
    aria-expanded={showSpeedMenu} aria-haspopup="menu"
    onContextMenu={e => { e.preventDefault(); cycleSpeed(); }}
    title="Change Tempo (Click to select, right-click or ↑/↓ to cycle)">{speed.toFixed(1)}×</button>;
  const preparation = loadingProgress?.waiting
    ? `${isPlaying ? 'Refilling audio' : 'Preparing audio'} · ${formatTime(loadingProgress.readySeconds)} of ${formatTime(loadingProgress.targetSeconds)} ready`
    : waitingForAudio ? 'Preparing audio…' : undefined;
  // Preparation details may contain a failure reason. Errors retain it as a
  // tooltip, while the visible action stays short and consistent.
  const message = isFetching ? undefined : noticeMessage ||
    (awaitingSavedRecording && !isError ? 'Checking for a saved recording…' : undefined) ||
    (!isError ? preparation || infoMessage : undefined) ||
    (isError ? 'Audio couldn’t be loaded' : isDegraded ? 'Word highlighting is estimated for this article' : undefined);
  const tone = noticeMessage ? 'notice' : isError ? 'error' :
    !preparation && !infoMessage && !awaitingSavedRecording && isDegraded ? 'degraded' : 'info';
  const statusLine = message && (
    <div className="reader-status" data-tone={tone} role={tone === 'error' || tone === 'notice' ? 'alert' : 'status'}>
      <div className="reader-status-message">
        <span title={tone === 'degraded' ? degradedMessage : isError ? infoMessage || errorMessage : message}>{message}</span>
        {noticeMessage && onDismissNotice ? <button onClick={onDismissNotice} title="Dismiss">Dismiss</button>
          : infoAction && <button onClick={infoAction.onClick} title={isError ? 'Retry audio' : undefined}>{isError ? 'Retry' : infoAction.label}</button>}
      </div>
      {loadingProgress?.waiting && !noticeMessage && !isError && !awaitingSavedRecording && (
        <progress className="reader-buffer-progress" aria-label="Audio preparation"
          max={Math.max(1, loadingProgress.targetSeconds)} value={Math.min(loadingProgress.readySeconds, loadingProgress.targetSeconds)} />
      )}
      {isPlaying && isBuffering && <span className="sr-only">Playback will resume automatically.</span>}
    </div>
  );

  return (
    <>
      <div className="reader-seek" role="slider" aria-label="Audio position" tabIndex={isFetching ? -1 : 0} aria-disabled={isFetching}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}
        aria-valuetext={`${formatTime(currentTime / safeSpeed)} of ${formatTime(duration / safeSpeed)}`}
        onKeyDown={e => {
          if (isFetching) return;
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Home' || e.key === 'End') onSeekProgress(e.key === 'Home' ? 0 : 100);
            else handleSkip(e.key === 'ArrowLeft' ? -15 : 15);
          }
        }}
        onPointerDown={isFetching ? undefined : handleTimelinePointerDown}
        onPointerMove={e => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverSeek(Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100)));
        }} onPointerLeave={() => setHoverSeek(null)} title="Drag to seek anywhere in the audio article">
        <div className="reader-seek-track"><div data-buffered={waitingForAudio || isError}
          style={{ width: `${isFetching ? 0 : waitingForAudio ? bufferPercent : Math.max(0, Math.min(100, progress))}%` }} /></div>
        {hoverSeek !== null && <span className="reader-seek-tooltip" style={{ left: `${Math.max(3, Math.min(97, hoverSeek))}%` }}>{formatTime(duration * hoverSeek / 100 / safeSpeed)}</span>}
      </div>
      <footer className="reader-controls" data-loading={isFetching || waitingForAudio} data-error={isError}>
        {isFetching || waitingForAudio ? (
          <div className="reader-loading-cluster">
            {statusLine}
            {isFetching ? <div className="reader-loading-indicator"><LoadingRing /></div> :
              <button className="reader-loading-indicator" disabled title="Play when audio is ready"><LoadingRing /></button>}
            {!isFetching && onToggleViewMode && <button className="reader-full-available" onClick={onToggleViewMode}>
              {viewMode === 'full' ? 'Return to Kinetic' : 'Full text is available now'}
            </button>}
          </div>
        ) : <>
          <div className="reader-bottom reader-fading" inert={!visible} data-force-visible={visible && !chromeVisible}>
            {visible && statusLine}
            <div className="reader-transport">{skip(-1)}{play()}{skip(1)}</div>
            <div className="reader-secondary">
              {tempo()}
              {onToggleViewMode && <><span aria-hidden="true">·</span><button onClick={onToggleViewMode} className={viewMode === 'full' ? 'reader-kinetic-link' : undefined}
                title={viewMode === 'kinetic' ? 'Show Full Article Text' : 'Return to Kinetic Reader'}>{viewMode === 'kinetic' ? 'Full text' : 'Kinetic'}</button></>}
              {sourceUrl && <><span aria-hidden="true">·</span><a href={sourceUrl} target="_blank" rel="noopener noreferrer" title="Open Original Source Article">Source</a></>}
              {viewMode === 'kinetic' && <><span aria-hidden="true">·</span><span className="reader-page-count">{pageNumber} / {pageCount}</span></>}
            </div>
          </div>
          {!visible && <div className="reader-ghost-cluster">{statusLine}<div className="reader-ghost">{play(true)}{tempo()}</div></div>}
        </>}
        {showSpeedMenu && !isFetching && !waitingForAudio && <>
          <button className="reader-menu-dismiss" aria-label="Close tempo menu" onClick={() => setShowSpeedMenu(false)} />
          <div className="reader-menu reader-speed-menu" role="menu" data-reader-menu
            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setShowSpeedMenu(false); } }}>
            {SPEED_OPTIONS.map(s => <button key={s} role="menuitemradio" aria-checked={Math.abs(s - speed) < 0.05}
              onClick={() => { onSpeedChange(s); setShowSpeedMenu(false); }}>{s.toFixed(1)}×</button>)}
          </div>
        </>}
      </footer>
    </>
  );
}
