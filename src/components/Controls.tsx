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
  isLoadingAudio?: boolean;
}

const SPEED_OPTIONS = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.2, 2.5, 3.0, 3.5];

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
  isLoadingAudio = false,
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
      el.removeEventListener('pointermove', handlePointerMove as any);
      el.removeEventListener('pointerup', handlePointerUp);
      el.removeEventListener('pointercancel', handlePointerUp);
    };

    el.addEventListener('pointermove', handlePointerMove as any);
    el.addEventListener('pointerup', handlePointerUp);
    el.addEventListener('pointercancel', handlePointerUp);
  };

  return (
    <div className="w-full pb-safe pt-2 select-none border-t border-white/5 bg-[#0B0C10]/90 backdrop-blur-lg z-20">
      {/* ── MOBILE CONTROLS (Design 3a: Thumb Zone) ── */}
      <div className="flex sm:hidden flex-col gap-3 px-4 pb-2">
        {/* Row 1: Timestamps & Waveform Seeker */}
        <div className="flex items-center gap-3 w-full">
          <span className="font-mono text-[10.5px] text-[#ECEAE4]/40 shrink-0 min-w-[36px]">
            {formattedCurrent}
          </span>

          <div
            onPointerDown={handleTimelinePointerDown}
            className="flex-1 relative h-6 rounded cursor-pointer overflow-hidden group select-none touch-none"
          >
            <div className="absolute inset-0 waveform-mask-base pointer-events-none" />
            <div
              className="absolute top-0 bottom-0 left-0 waveform-mask-active transition-all duration-75 pointer-events-none"
              style={{ width: `${progress}%` }}
            />
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-[#FFF7EA] shadow-[0_0_10px_rgba(242,163,60,0.9)] transition-all duration-75 pointer-events-none"
              style={{ left: `${progress}%` }}
            />
          </div>

          <span className="font-mono text-[10.5px] text-[#ECEAE4]/40 shrink-0 min-w-[40px] text-right">
            {formattedRemaining}
          </span>
        </div>

        {/* Row 2: -15s, 62px Play Button, +15s, Speed Pill */}
        <div className="flex items-center justify-center gap-6 relative pt-1">
          {/* -15s Skip */}
          <button
            onClick={() => handleSkip(-15)}
            className="relative w-9 h-9 rounded-full hover:bg-white/10 flex items-center justify-center text-white/75 hover:text-white transition active:scale-95"
            title="Rewind 15s"
          >
            <RotateCcw className="w-5 h-5" />
            <span className="absolute text-[8px] font-sans font-bold pt-0.5">15</span>
          </button>

          {/* 62px Amber Glow Play/Pause Circle */}
          {isLoadingAudio ? (
            <div className="w-[62px] h-[62px] rounded-full glow-amber-btn flex items-center justify-center animate-pulse">
              <Loader2 className="w-6 h-6 animate-spin text-[#16130B]" />
            </div>
          ) : (
            <button
              onClick={onTogglePlay}
              className="w-[62px] h-[62px] rounded-full glow-amber-btn flex items-center justify-center transition active:scale-95 shadow-[0_0_30px_rgba(242,163,60,0.4)]"
              title="Play / Pause"
            >
              {isPlaying ? (
                <Pause className="w-6 h-6 fill-[#16130B] text-[#16130B]" />
              ) : (
                <Play className="w-6 h-6 fill-[#16130B] text-[#16130B] ml-0.5" />
              )}
            </button>
          )}

          {/* +15s Skip */}
          <button
            onClick={() => handleSkip(15)}
            className="relative w-9 h-9 rounded-full hover:bg-white/10 flex items-center justify-center text-white/75 hover:text-white transition active:scale-95"
            title="Forward 15s"
          >
            <RotateCw className="w-5 h-5" />
            <span className="absolute text-[8px] font-sans font-bold pt-0.5">15</span>
          </button>

          {/* Speed Pill on Mobile */}
          <div className="absolute right-0 top-1/2 -translate-y-1/2">
            <button
              onClick={() => setShowSpeedMenu(!showSpeedMenu)}
              className="h-8 px-2.5 rounded-full glow-amber-badge flex items-center justify-center font-mono font-semibold text-xs transition active:scale-95"
            >
              <span>{safeSpeed.toFixed(1)}×</span>
            </button>

            {showSpeedMenu && (
              <div className="absolute bottom-11 right-0 bg-[#15161D] border border-white/10 rounded-2xl p-1.5 shadow-2xl flex flex-col gap-1 z-30 min-w-[90px]">
                {SPEED_OPTIONS.map((rate) => (
                  <button
                    key={rate}
                    onClick={() => {
                      onSpeedChange(rate);
                      setShowSpeedMenu(false);
                    }}
                    className={`px-3 py-1.5 text-xs font-mono rounded-xl transition text-left flex items-center justify-between ${
                      Math.abs(safeSpeed - rate) < 0.05
                        ? 'bg-[#F2A33C] text-[#16130B] font-bold'
                        : 'text-white/70 hover:bg-white/10'
                    }`}
                  >
                    <span>{rate.toFixed(1)}×</span>
                    {Math.abs(safeSpeed - rate) < 0.05 && <span className="w-1.5 h-1.5 rounded-full bg-[#16130B]" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── DESKTOP CONTROLS (Design 1a) ── */}
      <div className="hidden sm:flex items-center justify-between gap-5 px-6 py-2">
        {/* Left: Jump -15s, Play/Pause, Jump +15s */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => handleSkip(-15)}
            className="relative w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
            title="Rewind 15s (←)"
          >
            <RotateCcw className="w-4 h-4" />
            <span className="absolute text-[7px] font-mono font-bold pt-0.5">15</span>
          </button>

          {isLoadingAudio ? (
            <div className="w-12 h-12 rounded-full glow-amber-btn flex items-center justify-center animate-pulse">
              <Loader2 className="w-5 h-5 animate-spin text-[#16130B]" />
            </div>
          ) : (
            <button
              onClick={onTogglePlay}
              className="w-12 h-12 rounded-full glow-amber-btn flex items-center justify-center transition active:scale-95 shadow-lg"
              title="Play / Pause (Space)"
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 fill-[#16130B] text-[#16130B]" />
              ) : (
                <Play className="w-5 h-5 fill-[#16130B] text-[#16130B] ml-0.5" />
              )}
            </button>
          )}

          <button
            onClick={() => handleSkip(15)}
            className="relative w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
            title="Forward 15s (→)"
          >
            <RotateCw className="w-4 h-4" />
            <span className="absolute text-[7px] font-mono font-bold pt-0.5">15</span>
          </button>
        </div>

        {/* Center: Timestamp, Waveform Bar, Remaining */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span className="font-mono text-[11px] text-[#ECEAE4]/40 shrink-0 min-w-[36px]">
            {formattedCurrent}
          </span>

          <div
            onPointerDown={handleTimelinePointerDown}
            className="flex-1 relative h-6 rounded cursor-pointer overflow-hidden group select-none touch-none"
          >
            <div className="absolute inset-0 waveform-mask-base group-hover:opacity-80 transition pointer-events-none" />
            <div
              className="absolute top-0 bottom-0 left-0 waveform-mask-active transition-all duration-75 pointer-events-none"
              style={{ width: `${progress}%` }}
            />
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-[#FFF7EA] shadow-[0_0_10px_rgba(242,163,60,0.9)] transition-all duration-75 pointer-events-none"
              style={{ left: `${progress}%` }}
            />
          </div>

          <span className="font-mono text-[11px] text-[#ECEAE4]/40 shrink-0 min-w-[45px] text-right">
            {formattedRemaining}
          </span>
        </div>

        {/* Right: Speed Badge & Keyboard Shortcuts */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="relative">
            <button
              onClick={() => setShowSpeedMenu(!showSpeedMenu)}
              className="min-w-[54px] h-8 px-2.5 rounded-full glow-amber-badge flex items-center justify-center font-mono font-semibold text-xs transition active:scale-95"
              title="Audio Speed (↑ / ↓)"
            >
              <span>{safeSpeed.toFixed(1)}×</span>
            </button>

            {showSpeedMenu && (
              <div className="absolute bottom-11 right-0 bg-[#15161D] border border-white/10 rounded-2xl p-1.5 shadow-2xl flex flex-col gap-1 z-30 min-w-[90px]">
                {SPEED_OPTIONS.map((rate) => (
                  <button
                    key={rate}
                    onClick={() => {
                      onSpeedChange(rate);
                      setShowSpeedMenu(false);
                    }}
                    className={`px-3 py-1.5 text-xs font-mono rounded-xl transition text-left flex items-center justify-between ${
                      Math.abs(safeSpeed - rate) < 0.05
                        ? 'bg-[#F2A33C] text-[#16130B] font-bold'
                        : 'text-white/70 hover:bg-white/10'
                    }`}
                  >
                    <span>{rate.toFixed(1)}×</span>
                    {Math.abs(safeSpeed - rate) < 0.05 && <span className="w-1.5 h-1.5 rounded-full bg-[#16130B]" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Full Reading Mode Toggle */}
          {onToggleViewMode && (
            <button
              onClick={onToggleViewMode}
              className={`h-8 px-3 rounded-full text-xs font-sans font-medium flex items-center gap-1.5 transition active:scale-95 ${
                viewMode === 'full'
                  ? 'bg-white text-black font-semibold'
                  : 'bg-white/5 hover:bg-white/10 text-white/70'
              }`}
              title="Toggle Article Mode"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{viewMode === 'full' ? 'Kinetic' : 'Full Text'}</span>
            </button>
          )}

          {/* Original Source Link */}
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="h-8 w-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/50 hover:text-white transition"
              title="Open Original Source"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
