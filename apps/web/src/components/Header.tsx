import React from 'react';
import { Settings, PlusCircle, Film, User, ChevronLeft, Volume2, VolumeX, Zap } from 'lucide-react';
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
  isVoiceEnabled = true,
  onToggleVoice,
  isRampEnabled = false,
  onToggleRamp,
  clauseLength = 6,
  onChangeClauseLength,
}: HeaderProps) {
  return (
    <header className="w-full flex items-center justify-between py-3 px-3 sm:px-6 z-10 select-none border-b border-white/5 bg-[#0B0C10]/60 backdrop-blur-md">
      {/* Left: Article / Channel Info */}
      <div className="flex items-center gap-3 overflow-hidden pr-2">
        {onOpenLibrary && (
          <button
            onClick={onOpenLibrary}
            className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center shrink-0 text-white/70 hover:text-white transition active:scale-95"
            title="Back to Library & Queue"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}

        <div className="flex flex-col truncate">
          <h1 className="font-sans font-semibold text-[13px] text-[#ECEAE4] truncate tracking-tight">
            {article?.title || 'Why We Stopped Reading'}
          </h1>
          <div className="flex items-center gap-1 text-[11px] text-[#ECEAE4]/40 font-sans truncate">
            <span>{article?.author || 'The Atlantic'}</span>
            <span>·</span>
            <span>14 min →</span>
            <span className="text-[#F2A33C] font-medium">{(14 / speed).toFixed(0)} min</span>
          </div>
        </div>
      </div>

      {/* Center / Right: Interactive Prototype Controls */}
      <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
        {/* 1. Voice on / off Toggle (Prototype) */}
        {onToggleVoice && (
          <button
            onClick={onToggleVoice}
            className={`h-7 px-3 rounded-full flex items-center gap-1.5 font-sans font-medium text-[11.5px] transition active:scale-95 ${
              isVoiceEnabled
                ? 'bg-[#F2A33C]/15 text-[#F2A33C] border border-[#F2A33C]/35'
                : 'bg-white/5 text-[#ECEAE4]/50 border border-white/10 hover:bg-white/10'
            }`}
            title="Toggle Soniox Voice Audio"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isVoiceEnabled ? 'bg-[#F2A33C] shadow-[0_0_6px_rgba(242,163,60,0.8)]' : 'bg-white/30'
              }`}
            />
            <span className="hidden sm:inline">{isVoiceEnabled ? 'Voice on' : 'Voice off'}</span>
          </button>
        )}

        {/* 2. Tempo Ramp Mode (Prototype: automatically accelerates as reader builds cadence) */}
        {onToggleRamp && (
          <button
            onClick={onToggleRamp}
            className={`h-7 px-3 rounded-full hidden md:flex items-center gap-1.5 font-sans font-medium text-[11.5px] transition active:scale-95 ${
              isRampEnabled
                ? 'bg-[#F2A33C]/15 text-[#F2A33C] border border-[#F2A33C]/35'
                : 'bg-white/5 text-[#ECEAE4]/50 border border-white/10 hover:bg-white/10'
            }`}
            title="Auto-accelerate tempo gradually per clause"
          >
            <Zap className={`w-3 h-3 ${isRampEnabled ? 'text-[#F2A33C]' : 'text-white/40'}`} />
            <span>{isRampEnabled ? 'Ramp → 2.5× on' : 'Ramp off'}</span>
          </button>
        )}

        {/* 3. Short / Flow / Long Clause Chunking Selector (Prototype) */}
        {onChangeClauseLength && (
          <div className="hidden lg:flex bg-white/5 border border-white/10 rounded-full p-0.5 gap-0.5">
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
            className="h-7 px-3 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 flex items-center gap-1.5 font-sans font-medium text-[11px] text-[#ECEAE4]/80 hover:text-white transition active:scale-95"
            title="Create 9:16 Social Clip"
          >
            <Film className="w-3 h-3 text-[#F2A33C]" />
            <span>Clip</span>
          </button>
        )}

        {/* 5. Add Content (+) */}
        <button
          onClick={onOpenInput}
          className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
          title="Add Article or URL"
        >
          <PlusCircle className="w-4 h-4" />
        </button>

        {/* 6. Settings */}
        <button
          onClick={onOpenSettings}
          className="w-7 h-7 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
          title="Reader Settings"
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* 7. User Profile */}
        {user ? (
          <button
            onClick={onOpenAuth}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-[#F2A33C]/10 border border-[#F2A33C]/30 text-[#F2A33C] text-[11px] font-sans font-semibold hover:bg-[#F2A33C]/20 transition"
            title={`Signed in as ${user.email}`}
          >
            <img
              src={user.avatar || `https://unavatar.io/${user.email}`}
              alt=""
              className="w-4 h-4 rounded-full bg-gray-900 object-cover"
              onError={(e) => {
                (e.target as HTMLElement).style.display = 'none';
              }}
            />
            <span className="max-w-[65px] truncate">{user.name}</span>
          </button>
        ) : (
          <button
            onClick={onOpenAuth}
            className="flex items-center gap-1 h-7 px-3 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 text-white text-[11px] font-sans font-semibold transition active:scale-95"
          >
            <User className="w-3 h-3 text-[#F2A33C]" />
            <span>Sign In</span>
          </button>
        )}
      </div>
    </header>
  );
}
