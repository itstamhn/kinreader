import React, { useState, useEffect } from 'react';
import { X, Play, Pause, Clock, Sparkles, Trash2, ArrowRight, Link as LinkIcon, Compass, Archive, History, Settings, ExternalLink } from 'lucide-react';
import type { ArticleData } from '../types';
import type { UserProfile } from './AuthModal';

export interface SavedArticleItem {
  id: string;
  article: ArticleData;
  progress: number;
  lastReadAt: number;
  isCachedAudio?: boolean;
}

interface LibraryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  savedArticles: SavedArticleItem[];
  currentArticleId?: string;
  onSelectArticle: (article: ArticleData) => void;
  onDeleteArticle?: (id: string) => void;
  onQuickExtract?: (url: string) => void;
  onOpenSettings?: () => void;
  user?: UserProfile | null;
  onOpenAuth?: () => void;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  speed?: number;
}

export function LibraryDrawer({
  isOpen,
  onClose,
  savedArticles,
  currentArticleId,
  onSelectArticle,
  onDeleteArticle,
  onQuickExtract,
  onOpenSettings,
  user,
  onOpenAuth,
  isPlaying = false,
  onTogglePlay,
  speed = 1.5,
}: LibraryDrawerProps) {
  const [filter, setFilter] = useState<'All' | 'Substack' | 'X threads' | 'Web'>('All');
  const [fastUrl, setFastUrl] = useState('');

  if (!isOpen) return null;

  // Active top article (Hero card / Mini-player)
  const currentItem = savedArticles.find(
    (s) => s.article.sourceUrl === currentArticleId || s.article.title === currentArticleId
  ) || savedArticles[0];

  const filteredArticles = savedArticles.filter((item) => {
    if (filter === 'All') return true;
    if (filter === 'X threads') return item.article.sourceType === 'x' || /x\.com|twitter/i.test(item.article.sourceUrl || '');
    if (filter === 'Substack') return /substack/i.test(item.article.sourceUrl || '') || /newsletter/i.test(item.article.author || '');
    return item.article.sourceType === 'article' || item.article.sourceType === 'text';
  });

  const handlePasteExtract = () => {
    if (fastUrl.trim() && onQuickExtract) {
      onQuickExtract(fastUrl.trim());
      setFastUrl('');
      onClose();
    }
  };

  const handleNativeClipboardPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setFastUrl(text.trim());
        if (text.startsWith('http://') || text.startsWith('https://')) {
          if (onQuickExtract) {
            onQuickExtract(text.trim());
            onClose();
          }
        }
      }
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in p-0 sm:p-6 select-none"
    >
      <div className="w-full sm:max-w-5xl h-full sm:h-[92vh] sm:max-h-[780px] bg-[#0B0C10] sm:border sm:border-white/10 sm:rounded-3xl shadow-2xl flex flex-col sm:flex-row overflow-hidden relative pt-safe pb-safe">
        {/* 1. Left Sidebar Navigation (Desktop only) */}
        <div className="w-52 shrink-0 border-r border-white/5 p-5 hidden md:flex flex-col gap-2">
          {/* Logo */}
          <div className="font-serif font-medium text-2xl tracking-tight text-[#F4F0E6] px-2 pb-4">
            Kinreader<span className="text-[#F2A33C]">.</span>
          </div>

          <button className="flex items-center gap-3 h-10 px-3.5 rounded-xl bg-[#F2A33C]/10 text-[#F2A33C] font-sans font-semibold text-xs transition">
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none">
              <rect x="2.5" y="4" width="15" height="3" rx="1.5" fill="#F2A33C" />
              <rect x="2.5" y="9.5" width="10" height="3" rx="1.5" fill="rgba(242,163,60,.45)" />
              <rect x="2.5" y="15" width="13" height="3" rx="1.5" fill="rgba(242,163,60,.45)" />
            </svg>
            <span>Queue</span>
          </button>

          <button
            onClick={() => {
              if (onOpenSettings) {
                onClose();
                onOpenSettings();
              }
            }}
            className="flex items-center gap-3 h-10 px-3.5 rounded-xl hover:bg-white/5 text-white/55 hover:text-white font-sans font-medium text-xs transition"
          >
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </button>

          <div className="flex-1" />

          {/* Pro Promo Card */}
          <div className="rounded-2xl bg-gradient-to-br from-[#F2A33C]/15 to-[#F2A33C]/5 border border-[#F2A33C]/25 p-3.5 flex flex-col gap-1.5">
            <span className="font-sans font-semibold text-xs text-[#F4F0E6]">Kinreader Pro</span>
            <span className="font-sans text-[11px] leading-relaxed text-[#ECEAE4]/50">
              All neural voices, 3.5× tempo, unlimited articles.
            </span>
            <a
              href="https://buy.stripe.com/eVqfZbgvZeDH6Uc2zJ53O00"
              target="_blank"
              rel="noreferrer"
              className="font-sans font-semibold text-[11px] text-[#F2A33C] pt-1 hover:underline"
            >
              Start free trial →
            </a>
          </div>
        </div>

        {/* 2. Main Library Area */}
        <div className="flex-1 flex flex-col p-4 sm:p-7 gap-4 overflow-y-auto min-w-0 relative">
          {/* Mobile Header (Design 3b) */}
          <div className="flex sm:hidden items-center justify-between pt-2 pb-1">
            <div className="font-serif font-medium text-2xl tracking-tight text-[#F4F0E6]">
              Kinreader<span className="text-[#F2A33C]">.</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onOpenAuth}
                className="w-8 h-8 rounded-full bg-gradient-to-br from-[#2A2D38] to-[#181A21] border border-white/10 flex items-center justify-center font-sans font-semibold text-[11px] text-[#ECEAE4]/70"
              >
                {user ? user.name.slice(0, 2).toUpperCase() : 'JD'}
              </button>
              <button
                onClick={onClose}
                className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Fast Search / Paste Input Bar (Design 3b & 1b) */}
          <div className="flex items-center gap-2.5">
            <div className="flex-1 flex items-center gap-2.5 h-11 px-3.5 rounded-2xl bg-white/5 border border-white/10 focus-within:border-[#F2A33C]/50 transition">
              <LinkIcon className="w-4 h-4 text-white/40 shrink-0" />
              <input
                type="text"
                placeholder="Paste any article, Substack, or X link…"
                value={fastUrl}
                onChange={(e) => setFastUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handlePasteExtract();
                }}
                className="w-full bg-transparent border-none outline-none font-sans text-xs text-[#ECEAE4] placeholder-[#ECEAE4]/30"
              />
              <span className="hidden sm:inline font-mono text-[9px] text-[#ECEAE4]/30 px-2 py-0.5 border border-white/10 rounded">
                ⌘V
              </span>
            </div>

            <button
              onClick={fastUrl.trim() ? handlePasteExtract : handleNativeClipboardPaste}
              className="h-11 px-4 sm:px-5 rounded-2xl glow-amber-btn font-sans font-semibold text-xs transition active:scale-98 shrink-0"
            >
              {fastUrl.trim() ? 'Narrate' : 'Paste'}
            </button>

            {/* Desktop Profile Avatar */}
            <button
              onClick={onOpenAuth}
              className="hidden sm:flex w-9 h-9 rounded-full bg-gradient-to-br from-[#2A2D38] to-[#181A21] border border-white/10 items-center justify-center font-sans font-semibold text-xs text-[#ECEAE4]/70 shrink-0"
              title="Account Profile"
            >
              {user?.avatar ? (
                <img src={user.avatar} alt="" className="w-full h-full rounded-full object-cover" />
              ) : user ? (
                user.name.slice(0, 2).toUpperCase()
              ) : (
                'JD'
              )}
            </button>

            {/* Desktop Close Button */}
            <button
              onClick={onClose}
              className="hidden sm:flex w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 items-center justify-center text-white/50 hover:text-white transition shrink-0"
              title="Close Library (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Desktop Continue Hero Card (Design 1b) */}
          {currentItem && (
            <div
              onClick={() => {
                onSelectArticle(currentItem.article);
                onClose();
              }}
              className="hidden sm:flex rounded-3xl bg-gradient-to-br from-[#1B1D26] to-[#101117] border border-white/10 p-5 sm:p-6 items-center gap-5 cursor-pointer group hover:border-[#F2A33C]/40 transition shadow-xl select-none"
            >
              <div className="flex-1 flex flex-col gap-2 min-w-0">
                <div className="font-mono text-[9px] font-semibold tracking-widest uppercase text-[#F2A33C]">
                  CONTINUE · {Math.round(currentItem.progress || 0)}%
                </div>
                <div className="font-serif text-xl sm:text-2xl text-[#F4F0E6] group-hover:text-white transition truncate">
                  {currentItem.article.title}
                </div>
                <div className="font-sans text-xs text-[#ECEAE4]/45 truncate">
                  <span>{currentItem.article.author || 'Author'}</span>
                  <span> · 14 min → </span>
                  <span className="text-[#F2A33C] font-medium">6 min</span>
                  <span> · Soniox · 2.1×</span>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[#B87718] to-[#F2A33C]"
                      style={{ width: `${Math.max(10, currentItem.progress || 0)}%` }}
                    />
                  </div>
                  <span className="font-mono text-[10px] text-[#ECEAE4]/40">−03:41</span>
                </div>
              </div>

              <div className="flex items-center gap-2.5 shrink-0">
                {onDeleteArticle && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteArticle(currentItem.id);
                    }}
                    className="w-9 h-9 rounded-full bg-white/5 hover:bg-rose-500/20 text-white/40 hover:text-rose-400 flex items-center justify-center transition"
                    title="Delete current article"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
                <div className="w-14 h-14 rounded-full glow-amber-btn flex items-center justify-center shadow-lg group-hover:scale-105 transition">
                  <Play className="w-5 h-5 fill-[#16130B] text-[#16130B] ml-0.5" />
                </div>
              </div>
            </div>
          )}

          {/* Category Filter Tabs (Design 3b & 1b) */}
          <div className="flex items-center justify-between pt-1">
            <span className="font-sans font-semibold text-[11px] tracking-wider uppercase text-[#ECEAE4]/40">
              UP NEXT · {filteredArticles.length}
            </span>

            <div className="flex gap-1.5 sm:gap-2">
              {(['All', 'Substack', 'X threads', 'Web'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab)}
                  className={`h-7 px-3 rounded-full text-xs font-sans font-medium transition ${
                    filter === tab
                      ? 'bg-[#F4F0E6] text-[#16130B] font-semibold'
                      : 'bg-white/5 hover:bg-white/10 text-white/55'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          {/* Article List Rows */}
          <div className="flex-1 flex flex-col divide-y divide-white/5 pb-20 sm:pb-2">
            {filteredArticles.length === 0 ? (
              <div className="py-12 text-center text-xs text-white/40 font-sans">
                No articles in this filter.
              </div>
            ) : (
              filteredArticles.map((item) => {
                const isSubstack = /substack/i.test(item.article.sourceUrl || '') || /money stuff|noahpinion/i.test(item.article.title);
                const isX = item.article.sourceType === 'x' || /x\.com|twitter/i.test(item.article.sourceUrl || '');
                const dotColor = isSubstack ? '#FF6719' : isX ? '#ECEAE4' : '#5A8DEE';

                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      onSelectArticle(item.article);
                      onClose();
                    }}
                    className="flex items-center gap-3.5 py-3 px-2 hover:bg-white/5 rounded-xl cursor-pointer group transition justify-between"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: dotColor }}
                      />
                      <div className="flex-1 flex flex-col min-w-0">
                        <div className="font-serif text-[15px] text-[#ECEAE4] group-hover:text-white transition truncate">
                          {item.article.title}
                        </div>
                        <div className="font-sans text-[11px] text-[#ECEAE4]/40 truncate">
                          {item.article.author || 'Article'} · 9 min → 4 min
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {onDeleteArticle && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteArticle(item.id);
                          }}
                          className="w-8 h-8 rounded-lg hover:bg-rose-500/15 text-white/30 hover:text-rose-400 flex items-center justify-center transition"
                          title="Delete from Library"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 group-hover:text-[#F2A33C] transition">
                        <Play className="w-3.5 h-3.5 fill-current" />
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* ── MOBILE PERSISTENT FLOATING MINI-PLAYER (Design 3b) ── */}
          {currentItem && (
            <div
              onClick={() => {
                onSelectArticle(currentItem.article);
                onClose();
              }}
              className="sm:hidden absolute bottom-3 left-3 right-3 h-14 rounded-2xl bg-[#1C1D24]/95 backdrop-blur-xl border border-white/10 flex items-center gap-3 px-3 shadow-[0_10px_30px_rgba(0,0,0,0.5)] z-30 cursor-pointer"
            >
              {/* Mini Waveform Icon */}
              <div className="w-9 h-9 rounded-lg bg-[#0A0B0F] border border-white/10 flex items-center justify-center shrink-0">
                <Sparkles className="w-4 h-4 text-[#F2A33C]" />
              </div>

              {/* Title & Progress Bar */}
              <div className="flex-1 flex flex-col gap-1 min-w-0">
                <span className="font-sans font-semibold text-xs text-[#F4F0E6] truncate">
                  {currentItem.article.title}
                </span>
                <div className="h-[2.5px] rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#F2A33C]"
                    style={{ width: `${Math.max(10, currentItem.progress || 0)}%` }}
                  />
                </div>
              </div>

              {/* Speed */}
              <span className="font-mono font-semibold text-[11px] text-[#F2A33C]">
                {speed.toFixed(1)}×
              </span>

              {/* 38px Amber Play Button */}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  if (onTogglePlay) onTogglePlay();
                }}
                className="w-9 h-9 rounded-full glow-amber-btn flex items-center justify-center shrink-0 shadow-md"
              >
                {isPlaying ? (
                  <Pause className="w-3.5 h-3.5 fill-[#16130B] text-[#16130B]" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-[#16130B] text-[#16130B] ml-0.5" />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
