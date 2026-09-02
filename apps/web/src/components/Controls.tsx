import React, { useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  ExternalLink,
  BookOpen,
  Volume2,
  Sparkles,
  Loader2,
  AlertCircle,
} from 'lucide-react';

interface ControlsProps {
  isPlaying: boolean;
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
  onTogglePlay,
  speed,
  onSpeedChange,
  progress,
  onSeekProgress,
  currentTime,
  duration,
  remainingSeconds,
  sourceUrl,
  sourceType,
  viewMode = 'kinetic',
  onToggleViewMode,
  isSynthesizing = false,
  isPlayable = true,
  isBuffering = isSynthesizing,
  isDegraded = false,
  isError = false,
  degradedMessage = 'Neural voice unavailable (using on-device speech).',
  errorMessage = 'Audio playback unavailable on this device.',
  noticeMessage,
  onDismissNotice,
  infoMessage,
  infoBusy = true,
  infoAction,
}: ControlsProps) {
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return '00:00';
    const s = Math.floor(secs);
    const m = Math.floor(s / 60);
    const remainder = s % 60;
    return `${m.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
  };

  const safeSpeed = speed > 0 ? speed : 1.0;
  const realCurrent = currentTime / safeSpeed;
  const realRemaining = Math.max(0, (duration - currentTime) / safeSpeed);
  const formattedCurrent = formatTime(realCurrent);
  const formattedRemaining = `−${formatTime(realRemaining)}`;

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

  return (
    <footer className="w-full flex flex-col z-20 select-none border-t border-white/5 bg-[#0B0C10]/80 backdrop-blur-lg pb-safe">
      {/* Primary Playback Bar (Matching Design 1a & 1b) */}
      <div className="w-full flex items-center gap-3 sm:gap-5 py-3.5 px-4 sm:px-6">
        {/* Left: Playback Controls (15s Rewind, Play/Pause, 15s Skip) */}
        <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
          {/* 15s Back */}
          <button
            onClick={() => handleSkip(-15)}
            className="relative w-7 h-7 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
            title="Rewind 15 seconds"
          >
            <svg width="24" height="24" viewBox="0 0 30 30" fill="none">
              <path
                d="M15 4a11 11 0 1 1-8.6 4.1"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M6.5 2.5v6h6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="absolute font-sans font-semibold text-[8px] pt-0.5 text-white/80">
              15
            </span>
          </button>

          {/* Big Play / Pause Button (52px Orange Amber Gradient) */}
          <button
            onClick={onTogglePlay}
            disabled={!isPlayable || isError}
            className="w-[46px] h-[46px] sm:w-[52px] sm:h-[52px] rounded-full flex items-center justify-center shrink-0 transition-all duration-150 active:scale-95 glow-amber-btn shadow-lg disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              isError
                ? 'Audio unavailable'
                : isBuffering
                  ? 'Play (buffering)'
                  : isPlaying
                    ? 'Pause (Space)'
                    : 'Play (Space)'
            }
          >
            {isBuffering ? (
              <Loader2 className="w-5 h-5 text-[#16130B] animate-spin" />
            ) : isPlaying ? (
              <svg width="16" height="20" viewBox="0 0 22 26">
                <rect x="3" y="2" width="5.5" height="22" rx="2.2" fill="#16130B" />
                <rect x="13.5" y="2" width="5.5" height="22" rx="2.2" fill="#16130B" />
              </svg>
            ) : (
              <svg width="18" height="20" viewBox="0 0 12 14" className="translate-x-0.5">
                <path
                  d="M2 2v10c0 .8.9 1.3 1.6.9l8-5c.6-.4.6-1.4 0-1.8l-8-5C2.9.7 2 1.2 2 2z"
                  fill="#16130B"
                />
              </svg>
            )}
          </button>

          {/* 15s Forward */}
          <button
            onClick={() => handleSkip(15)}
            className="relative w-7 h-7 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
            title="Fast forward 15 seconds"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 30 30"
              fill="none"
              style={{ transform: 'scaleX(-1)' }}
            >
              <path
                d="M15 4a11 11 0 1 1-8.6 4.1"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <path
                d="M6.5 2.5v6h6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="absolute font-sans font-semibold text-[8px] pt-0.5 text-white/80">
              15
            </span>
          </button>
        </div>

        {/* Elapsed Timestamp */}
        <span className="font-mono font-medium text-[11px] text-[#ECEAE4]/40 shrink-0 select-none">
          {formattedCurrent}
        </span>

        {/* Center: Striated Waveform Scrubber (Design 1a) */}
        <div
          onPointerDown={handleTimelinePointerDown}
          className="flex-1 relative h-[26px] rounded overflow-hidden cursor-pointer touch-none select-none bg-white/[0.03]"
          title="Drag to seek anywhere in the audio article"
        >
          {/* Base Inactive Waveform */}
          <div className="absolute inset-0 waveform-mask-base pointer-events-none" />

          {/* Active Played Waveform */}
          <div
            className="absolute top-0 bottom-0 left-0 waveform-mask-active pointer-events-none"
            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
          />

          {/* Glowing Amber Playhead Needle */}
          <div
            className="absolute top-0 bottom-0 pointer-events-none transition-transform duration-75"
            style={{
              left: `${Math.max(0, Math.min(100, progress))}%`,
              width: '2px',
              backgroundColor: '#FFF7EA',
              boxShadow: '0 0 10px rgba(242,163,60,0.9)',
            }}
          />
        </div>

        {/* Remaining Timestamp */}
        <span className="font-mono font-medium text-[11px] text-[#ECEAE4]/40 shrink-0 select-none">
          {formattedRemaining}
        </span>

        {/* Right: Tempo Pill & View Toggles */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 relative">
          {/* Tempo Pill Button */}
          <div className="relative">
            <button
              onClick={() => setShowSpeedMenu(!showSpeedMenu)}
              onContextMenu={(e) => {
                e.preventDefault();
                cycleSpeed();
              }}
              className="min-w-[48px] sm:min-w-[52px] h-8 px-2 rounded-full font-mono font-semibold text-[12px] sm:text-[13px] text-[#F2A33C] bg-[#F2A33C]/15 border border-[#F2A33C]/35 flex items-center justify-center transition active:scale-95"
              title="Change Tempo (Click to select, right-click or ↑/↓ to cycle)"
            >
              {speed.toFixed(1)}×
            </button>

            {/* Speed Selector Popover */}
            {showSpeedMenu && (
              <div className="absolute bottom-11 right-0 bg-[#16171E] border border-white/10 rounded-2xl shadow-2xl p-1.5 flex flex-col gap-0.5 z-50 w-24 animate-fade-in">
                {SPEED_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      onSpeedChange(s);
                      setShowSpeedMenu(false);
                    }}
                    className={`h-7 rounded-lg text-xs font-mono font-medium transition flex items-center justify-between px-2.5 ${
                      Math.abs(s - speed) < 0.05
                        ? 'bg-[#F2A33C] text-[#16130B] font-bold'
                        : 'text-[#ECEAE4]/70 hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <span>{s.toFixed(1)}×</span>
                    {Math.abs(s - speed) < 0.05 && <span>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Full Article Text Toggle */}
          {onToggleViewMode && (
            <button
              onClick={onToggleViewMode}
              className={`h-8 px-3 rounded-full flex items-center gap-1.5 font-sans font-medium text-xs border transition ${
                viewMode === 'full'
                  ? 'bg-white/15 text-white border-white/20'
                  : 'bg-white/5 text-[#ECEAE4]/60 border-white/10 hover:text-white'
              }`}
              title={viewMode === 'kinetic' ? 'Show Full Article Text' : 'Return to Kinetic Reader'}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">
                {viewMode === 'kinetic' ? 'Full Text' : 'Kinetic'}
              </span>
            </button>
          )}

          {/* Source Link */}
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center text-white/50 hover:text-white transition"
              title="Open Original Source Article"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* Synthesis / Degraded / Error Notice Banner */}
      {noticeMessage ? (
        <div
          role="alert"
          className="w-full bg-rose-500/10 border-t border-rose-500/20 px-4 py-1.5 flex items-center justify-center gap-2 text-[11px] font-sans text-rose-300"
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{noticeMessage}</span>
          {onDismissNotice && (
            <button
              onClick={onDismissNotice}
              className="ml-2 shrink-0 underline underline-offset-2 hover:text-white"
              title="Dismiss"
            >
              Dismiss
            </button>
          )}
        </div>
      ) : infoMessage ? (
        <div className="w-full bg-white/[0.04] border-t border-white/10 px-4 py-1.5 flex items-center justify-center gap-2 text-[11px] font-sans text-[#ECEAE4]/70">
          {infoBusy ? (
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
          ) : (
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          )}
          <span>{infoMessage}</span>
          {infoAction && (
            <button
              onClick={infoAction.onClick}
              className="ml-2 shrink-0 font-semibold text-[#F2A33C] underline underline-offset-2 hover:text-white"
            >
              {infoAction.label}
            </button>
          )}
        </div>
      ) : isError ? (
        <div className="w-full bg-rose-500/10 border-t border-rose-500/20 px-4 py-1.5 flex items-center justify-center gap-2 text-[11px] font-sans text-rose-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      ) : isDegraded ? (
        <div className="w-full bg-[#F2A33C]/10 border-t border-[#F2A33C]/20 px-4 py-1.5 flex items-center justify-center gap-2 text-[11px] font-sans text-[#F2A33C]">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{degradedMessage}</span>
        </div>
      ) : null}
    </footer>
  );
}
