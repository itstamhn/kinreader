import React from 'react';
import { Settings, PlusCircle, ChevronLeft, Zap } from 'lucide-react';
import type { ArticleData } from '../types';
import type { UserProfile } from './AuthModal';

interface HeaderProps {
  article: ArticleData | null;
  onOpenSettings: () => void;
  onOpenInput: () => void;
  onOpenLibrary?: () => void;
  user?: UserProfile | null;
  onOpenAuth?: () => void;
  speed?: number;
  progress?: number;
  isVoiceEnabled?: boolean;
  onToggleVoice?: () => void;
  isRampEnabled?: boolean;
  onToggleRamp?: () => void;
}

export function Header({
  article,
  onOpenSettings,
  onOpenInput,
  onOpenLibrary,
  user,
  onOpenAuth,
  speed = 1.5,
  progress = 0,
  isVoiceEnabled = true,
  onToggleVoice,
  isRampEnabled = false,
  onToggleRamp,
}: HeaderProps) {
  return (
    <header className="w-full flex flex-col z-10 select-none bg-[#0B0C10]/70 backdrop-blur-md">
      {/* Minimal Top Header Bar */}
      <div className="w-full flex items-center justify-between py-3 px-3 sm:px-6">
        {/* Left: Library button + Article Title & Metadata */}
        <div className="flex items-center gap-3 overflow-hidden pr-2">
          {onOpenLibrary && (
            <button
              onClick={onOpenLibrary}
              className="w-8 h-8 rounded-full bg-white/[0.07] hover:bg-white/15 flex items-center justify-center shrink-0 text-white/70 hover:text-white transition active:scale-95"
              title="Library & Queue"
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

        {/* Right: Minimal Essential Actions */}
        <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
          {/* 1. Neural Voice Toggle Pill */}
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
              <span>{isVoiceEnabled ? 'Voice on' : 'Voice off'}</span>
            </button>
          )}

          {/* 2. Tempo Auto-Ramp Mode */}
          {onToggleRamp && (
            <button
              onClick={onToggleRamp}
              className={`h-[30px] px-3 rounded-full hidden sm:flex items-center gap-1.5 font-sans font-medium text-[11.5px] transition active:scale-95 ${
                isRampEnabled
                  ? 'bg-[#F2A33C]/15 text-[#F2A33C] border border-[#F2A33C]/35'
                  : 'bg-white/[0.06] text-[#ECEAE4]/50 hover:text-white'
              }`}
              title="Auto-accelerate tempo gradually per clause"
            >
              <Zap className={`w-3 h-3 ${isRampEnabled ? 'text-[#F2A33C]' : 'text-white/40'}`} />
              <span>{isRampEnabled ? 'Ramp on' : 'Ramp off'}</span>
            </button>
          )}

          {/* 3. Add Article (+) */}
          <button
            onClick={onOpenInput}
            className="w-[30px] h-[30px] rounded-full bg-white/[0.06] hover:bg-white/15 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
            title="Add Article or URL"
          >
            <PlusCircle className="w-4 h-4" />
          </button>

          {/* 4. Settings */}
          <button
            onClick={onOpenSettings}
            className="w-[30px] h-[30px] rounded-full bg-white/[0.06] hover:bg-white/15 flex items-center justify-center text-white/70 hover:text-white transition active:scale-95"
            title="Preferences"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          {/* 5. User Sign In / Profile */}
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

      {/* Top 2px Progress Line */}
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
