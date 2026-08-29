import React from 'react';
import { Settings, PlusCircle, Film, User, ChevronLeft, Zap, Sparkles } from 'lucide-react';
import type { ArticleData } from '../types';
import type { UserProfile } from './AuthModal';

interface HeaderProps {
  article: ArticleData | null;
  onOpenSettings: () => void;
  onOpenInput: () => void;
  onOpenLibrary?: () => void;
  onOpenClip?: () => void;
  user?: UserProfile | null;
  onOpenAuth?: () => void;
  speed?: number;
  progress?: number;
  isVoiceEnabled?: boolean;
  onToggleVoice?: () => void;
  isRampEnabled?: boolean;
  onToggleRamp?: () => void;
  clauseLength?: 4 | 6 | 9;
  onChangeClauseLength?: (len: 4 | 6 | 9) => void;
}

export function Header({
  article,
  onOpenSettings,
  onOpenInput,
  onOpenLibrary,
  onOpenClip,
  user,
  onOpenAuth,
  speed = 1.5,
  progress = 0,
  isVoiceEnabled = true,
  onToggleVoice,
  isRampEnabled = false,
  onToggleRamp,
  clauseLength = 6,
  onChangeClauseLength,
}: HeaderProps) {
  return (
    <header className="w-full flex flex-col z-10 select-none bg-[#0B0C10]/70 backdrop-blur-md">
      {/* Top Header Bar */}
      <div className="w-full flex items-center justify-between py-3 px-3 sm:px-6">
        {/* Left: Back + Article Info (Design 1a) */}
        <div className="flex items-center gap-3.5 overflow-hidden pr-2">
          {onOpenLibrary && (
            <button
              onClick={onOpenLibrary}
              className="w-8 h-8 rounded-full bg-white/[0.07] hover:bg-white/15 flex items-center justify-center shrink-0 text-white/70 hover:text-white transition active:scale-95"
              title="Back to Library & Queue"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}

          <div className="flex flex-col truncate">
            <h1 className="font-sans font-semibold text-[13px] text-[#ECEAE4] truncate tracking-tight">
              {article?.title || 'Why We Stopped Reading'}
            </h1>
            <div className="flex items-center gap-1.5 text-[11px] text-[#ECEAE4]/40 font-sans truncate">
              <span>{article?.author || 'The Atlantic'}</span>
              <span>·</span>
              <span>14 min →</span>
              <span className="text-[#F2A33C] font-medium">
                {(14 / (speed > 0 ? speed : 1)).toFixed(0)} min
              </span>
            </div>
          </div>
        </div>

        {/* Right: Controls & Actions (Design 1a) */}
        <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
          {/* 1. Voice Pill Indicator (Nova · 0 ms) */}
          {onToggleVoice && (
            <button
              onClick={onToggleVoice}
              className={`h-[30px] px-3.5 rounded-full flex items-center gap-1.5 font-sans font-medium text-[11.5px] transition active:scale-95 ${
                isVoiceEnabled
                  ? 'bg-white/[0.06] text-[#ECEAE4]/80 hover:text-white'
                  : 'bg-white/5 text-[#ECEAE4]/40 hover:bg-white/10'
              }`}
              title="Toggle Neural Voice"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isVoiceEnabled
                    ? 'bg-[#F2A33C] shadow-[0_0_6px_rgba(242,163,60,0.8)]'
                    : 'bg-white/30'
                }`}
              />
              <span>{isVoiceEnabled ? 'Nova · 0 ms' : 'Muted'}</span>
            </button>
          )}

          {/* 2. Tempo Ramp Mode */}
          {onToggleRamp && (
            <button
              onClick={onToggleRamp}
              className={`h-[30px] px-3.5 rounded-full hidden md:flex items-center gap-1.5 font-sans font-medium text-[11.5px] transition active:scale-95 ${
                isRampEnabled
                  ? 'bg-[#F2A33C]/15 text-[#F2A33C] border border-[#F2A33C]/35'
                  : 'bg-white/[0.06] text-[#ECEAE4]/60 hover:text-white'
              }`}
              title="Auto-accelerate tempo gradually per clause"
            >
              <Zap className={`w-3 h-3 ${isRampEnabled ? 'text-[#F2A33C]' : 'text-white/40'}`} />
              <span>{isRampEnabled ? 'Ramp → 2.5×' : 'Ramp off'}</span>
            </button>
          )}

          {/* 3. Clause Length Selector (Short / Flow / Long) */}
          {onChangeClauseLength && (
            <div className="hidden lg:flex bg-white/[0.06] rounded-full p-0.5 gap-0.5">
              {(
                [
                  { len: 4, label: 'Short' },
                  { len: 6, label: 'Flow' },
                  { len: 9, label: 'Long' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.len}
                  onClick={() => onChangeClauseLength(opt.len)}
                  className={`h-6 px-2.5 rounded-full text-[11px] font-sans font-semibold transition ${
                    clauseLength === opt.len
                      ? 'bg-[#F2A33C] text-[#16130B]'
                      : 'text-[#ECEAE4]/50 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {/* 4. Clip Button */}
          {onOpenClip && (
            <button
              onClick={onOpenClip}
              className="h-[30px] px-3.5 rounded-full bg-white/[0.06] hover:bg-white/15 flex items-center gap-1.5 font-sans font-medium text-[11.5px] text-[#ECEAE4]/80 hover:text-white transition active:scale-95"
              title="Create 9:16 Social Clip"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <circle cx="12.5" cy="3.5" r="2.2" stroke="rgba(236,234,228,.8)" strokeWidth="1.4" />
                <circle cx="3.5" cy="8" r="2.2" stroke="rgba(236,234,228,.8)" strokeWidth="1.4" />
                <circle cx="12.5" cy="12.5" r="2.2" stroke="rgba(236,234,228,.8)" strokeWidth="1.4" />
                <path
                  d="M5.5 7 10.5 4.5M5.5 9l5 2.5"
                  stroke="rgba(236,234,228,.8)"
                  strokeWidth="1.4"
                />
              </svg>
              <span>Clip</span>
            </button>
          )}

          {/* 5. Add Content (+) */}
          <button
            onClick={onOpenInput}
            className="w-[30px] h-[30px] rounded-full bg-white/[0.06] hover:bg-white/15 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
            title="Add Article or URL"
          >
            <PlusCircle className="w-4 h-4" />
          </button>

          {/* 6. Settings */}
          <button
            onClick={onOpenSettings}
            className="w-[30px] h-[30px] rounded-full bg-white/[0.06] hover:bg-white/15 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
            title="Preferences & Audio Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          {/* 7. Auth Avatar / Sign In */}
          {user ? (
            <button
              onClick={onOpenAuth}
              className="w-8 h-8 rounded-full bg-gradient-to-br from-[#2A2D38] to-[#181A21] border border-white/15 flex items-center justify-center text-xs font-semibold text-[#ECEAE4] hover:border-[#F2A33C]/50 transition shrink-0"
              title={`Signed in as ${user.name || user.email}`}
            >
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={user.name || user.email}
                  className="w-full h-full rounded-full object-cover"
                />
              ) : (
                (user.name || user.email).charAt(0).toUpperCase()
              )}
            </button>
          ) : (
            <button
              onClick={onOpenAuth}
              className="h-[30px] px-3.5 rounded-full bg-white/[0.06] hover:bg-white/15 text-xs font-sans font-semibold text-[#ECEAE4] hover:text-white transition active:scale-95"
            >
              Sign In
            </button>
          )}
        </div>
      </div>

      {/* Top 2px Progress Line (Design 1a) */}
      <div className="w-full px-4 sm:px-6">
        <div className="w-full h-[2px] rounded-full bg-white/[0.08] overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-150"
            style={{
              width: `${Math.max(0, Math.min(100, progress))}%`,
              background: 'linear-gradient(90deg, #B87718, #F2A33C)',
              boxShadow: '0 0 8px rgba(242,163,60,0.5)',
            }}
          />
        </div>
      </div>
    </header>
  );
}
