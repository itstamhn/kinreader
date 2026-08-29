import React, { useState, useEffect } from 'react';
import {
  X,
  Play,
  Pause,
  Clock,
  Sparkles,
  Trash2,
  ArrowRight,
  Link as LinkIcon,
  Settings,
  Type,
  Volume2,
  Check,
  ExternalLink,
} from 'lucide-react';
import type { ArticleData, ReaderSettings } from '../types';
import type { UserProfile } from './AuthScreen';

export interface SavedArticleItem {
  id: string;
  article: ArticleData;
  progress: number;
  lastReadAt: number;
  isCachedAudio?: boolean;
}

const SONIOX_VOICES = [
  { id: 'Adrian', name: 'Adrian', desc: 'Warm Narrative (Default)' },
  { id: 'Emma', name: 'Emma', desc: 'Clear & Articulate' },
  { id: 'Alex', name: 'Alex', desc: 'Deep & Authoritative' },
  { id: 'Sophie', name: 'Sophie', desc: 'Engaging & Smooth' },
  { id: 'Oliver', name: 'Oliver', desc: 'Calm & Rhythmic' },
];

const DEFAULT_READER_SETTINGS: ReaderSettings = {
  ttsProvider: 'soniox',
  sonioxApiKey: '',
  sonioxVoice: 'Adrian',
  groqApiKey: '',
  elevenApiKey: '',
  elevenVoiceId: '21m00Tcm4TlvDq8ikWAM',
  defaultRate: 1.5,
};

export interface LibraryDrawerProps {
  isOpen?: boolean;
  onClose: () => void;
  savedArticles: SavedArticleItem[];
  currentArticleId?: string;
  onSelectArticle: (article: ArticleData) => void;
  onDeleteArticle?: (id: string) => void;
  onQuickExtract?: (url: string) => void;
  user?: UserProfile | null;
  onOpenAuth?: () => void;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  speed?: number;
  settings?: ReaderSettings;
  onSaveSettings?: (newSettings: ReaderSettings) => void;
  initialTab?: 'queue' | 'settings';
}

export function LibraryDrawer({
  isOpen = true,
  onClose,
  savedArticles,
  currentArticleId,
  onSelectArticle,
  onDeleteArticle,
  onQuickExtract,
  user,
  onOpenAuth,
  isPlaying = false,
  onTogglePlay,
  speed = 1.5,
  settings = DEFAULT_READER_SETTINGS,
  onSaveSettings,
  initialTab = 'queue',
}: LibraryDrawerProps) {
  const [currentTab, setCurrentTab] = useState<'queue' | 'settings'>(initialTab);
  const [filter, setFilter] = useState<'All' | 'Substack' | 'X threads' | 'Web'>('All');
  const [fastUrl, setFastUrl] = useState('');

  useEffect(() => {
    setCurrentTab(initialTab);
  }, [initialTab, isOpen]);

  if (!isOpen) return null;

  const currentFontSize = settings.fontSize || 'md';
  const currentDefaultRate = settings.defaultRate || 1.5;
  const currentSonioxVoice = settings.sonioxVoice || 'Adrian';

  const handleUpdateSettings = (updates: Partial<ReaderSettings>) => {
    const updated = { ...settings, ...updates };
    if (onSaveSettings) onSaveSettings(updated);
  };

  // Active top article (Hero card / Mini-player)
  const currentItem =
    savedArticles.find(
      (s) => s.article.sourceUrl === currentArticleId || s.article.title === currentArticleId
    ) || savedArticles[0];

  const filteredArticles = savedArticles.filter((item) => {
    if (filter === 'All') return true;
    if (filter === 'X threads') return /x\.com|twitter/i.test(item.article.sourceUrl || '');
    if (filter === 'Substack')
      return (
        /substack/i.test(item.article.sourceUrl || '') ||
        /newsletter/i.test(item.article.author || '')
      );
    return true;
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

  return (
    <div className="w-full h-full flex flex-col md:flex-row overflow-hidden select-none animate-fade-in pt-safe pb-safe bg-[#0B0C10]">
      {/* 1. Left Sidebar Navigation (Desktop only - Design 1b) */}
      <div className="w-[230px] shrink-0 border-r border-white/5 p-6 hidden md:flex flex-col gap-2 bg-[#0B0C10]">
        {/* Logo */}
        <div className="font-serif font-medium text-2xl tracking-tight text-[#F4F0E6] px-2 pb-4">
          Kinreader<span className="text-[#F2A33C]">.</span>
        </div>

        <button
          onClick={() => setCurrentTab('queue')}
          className={`flex items-center gap-3 h-10 px-3.5 rounded-xl font-sans text-xs font-semibold transition ${
            currentTab === 'queue'
              ? 'bg-[#F2A33C]/10 text-[#F2A33C]'
              : 'text-white/55 hover:bg-white/5 hover:text-white'
          }`}
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none">
            <rect
              x="2.5"
              y="4"
              width="15"
              height="3"
              rx="1.5"
              fill={currentTab === 'queue' ? '#F2A33C' : 'rgba(236,234,228,.5)'}
            />
            <rect
              x="2.5"
              y="9.5"
              width="10"
              height="3"
              rx="1.5"
              fill={currentTab === 'queue' ? 'rgba(242,163,60,.45)' : 'rgba(236,234,228,.3)'}
            />
            <rect
              x="2.5"
              y="15"
              width="13"
              height="3"
              rx="1.5"
              fill={currentTab === 'queue' ? 'rgba(242,163,60,.45)' : 'rgba(236,234,228,.3)'}
            />
          </svg>
          <span>Queue</span>
        </button>

        <button
          onClick={() => setCurrentTab('settings')}
          className={`flex items-center gap-3 h-10 px-3.5 rounded-xl font-sans text-xs font-medium transition ${
            currentTab === 'settings'
              ? 'bg-[#F2A33C]/10 text-[#F2A33C] font-semibold'
              : 'text-white/55 hover:bg-white/5 hover:text-white'
          }`}
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

      {/* 2. Main Area */}
      <div className="flex-1 flex flex-col p-6 sm:p-9 gap-6 overflow-y-auto min-w-0 bg-[#0B0C10]">
        {/* Mobile Header (Design 3b) */}
        <div className="flex sm:hidden items-center justify-between pt-2 pb-1">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setCurrentTab('queue')}
              className={`font-serif font-medium text-xl tracking-tight transition ${
                currentTab === 'queue' ? 'text-[#F4F0E6]' : 'text-white/40'
              }`}
            >
              Queue<span className="text-[#F2A33C]">.</span>
            </button>
            <button
              onClick={() => setCurrentTab('settings')}
              className={`font-serif font-medium text-xl tracking-tight transition ${
                currentTab === 'settings' ? 'text-[#F4F0E6]' : 'text-white/40'
              }`}
            >
              Settings
            </button>
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

        {/* TAB 1: QUEUE (Design 1b) */}
        {currentTab === 'queue' && (
          <div className="flex-1 flex flex-col gap-6 w-full max-w-5xl">
            {/* Fast Search / Paste Input Bar */}
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
                  <img
                    src={user.avatar}
                    alt=""
                    className="w-full h-full rounded-full object-cover"
                  />
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
                title="Back to Reader (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Desktop Continue Hero Card */}
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
                    <span> · Adrian · {speed}×</span>
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

            {/* Category Filter Tabs */}
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
                        : 'bg-white/5 text-[#ECEAE4]/60 hover:text-white'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            {/* Article Queue List */}
            <div className="flex flex-col divide-y divide-white/5">
              {filteredArticles.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    onSelectArticle(item.article);
                    onClose();
                  }}
                  className="flex items-center justify-between py-3.5 px-2 hover:bg-white/[0.03] rounded-xl transition cursor-pointer group"
                >
                  <div className="flex items-center gap-3.5 min-w-0 pr-4">
                    <div
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        /x\.com|twitter/i.test(item.article.sourceUrl || '')
                          ? 'bg-sky-400'
                          : /substack/i.test(item.article.sourceUrl || '') ||
                              /newsletter/i.test(item.article.author || '')
                            ? 'bg-orange-500'
                            : 'bg-[#F2A33C]'
                      }`}
                    />
                    <div className="flex flex-col truncate">
                      <span className="font-serif text-base text-[#ECEAE4] group-hover:text-white truncate transition">
                        {item.article.title}
                      </span>
                      <div className="flex items-center gap-1.5 text-[11px] text-[#ECEAE4]/40 font-sans">
                        <span>{item.article.author || 'Author'}</span>
                        <span>·</span>
                        <span className="text-[#F2A33C]">9 → 4 min</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {onDeleteArticle && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteArticle(item.id);
                        }}
                        className="w-8 h-8 rounded-full opacity-0 group-hover:opacity-100 hover:bg-rose-500/20 text-white/30 hover:text-rose-400 flex items-center justify-center transition"
                        title="Delete article"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <Play className="w-3.5 h-3.5 text-white/40 group-hover:text-[#F2A33C] transition" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 2: SETTINGS (Full-width Integrated Screen) */}
        {currentTab === 'settings' && (
          <div className="flex-1 flex flex-col gap-6 w-full max-w-5xl">
            {/* Header with full-width alignment */}
            <div className="flex items-center justify-between pb-4 border-b border-white/5">
              <div>
                <h2 className="font-serif text-2xl sm:text-3xl text-[#F4F0E6]">Settings & Preferences</h2>
                <p className="font-sans text-xs sm:text-sm text-[#ECEAE4]/40 pt-1">
                  Customize your kinetic reading velocity, focal text size, and neural narrator voice.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={onOpenAuth}
                  className="hidden sm:flex w-9 h-9 rounded-full bg-gradient-to-br from-[#2A2D38] to-[#181A21] border border-white/10 items-center justify-center font-sans font-semibold text-xs text-[#ECEAE4]/70 shrink-0"
                  title="Account Profile"
                >
                  {user?.avatar ? (
                    <img
                      src={user.avatar}
                      alt=""
                      className="w-full h-full rounded-full object-cover"
                    />
                  ) : user ? (
                    user.name.slice(0, 2).toUpperCase()
                  ) : (
                    'JD'
                  )}
                </button>
                <button
                  onClick={onClose}
                  className="hidden sm:flex w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 items-center justify-center text-white/50 hover:text-white transition shrink-0"
                  title="Back to Reader (Esc)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* 1. Focal Text Scale */}
            <div className="flex flex-col gap-3">
              <label className="font-sans text-xs sm:text-sm font-semibold text-[#ECEAE4]/80 flex items-center gap-2">
                <Type className="w-4 h-4 text-[#F2A33C]" />
                <span>Focal Text Scale</span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(
                  [
                    { id: 'sm', label: 'Compact', desc: '36px font scale' },
                    { id: 'md', label: 'Standard', desc: '46px font scale (Default)' },
                    { id: 'lg', label: 'Large', desc: '56px font scale' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => {
                      handleUpdateSettings({ fontSize: opt.id });
                    }}
                    className={`p-4 rounded-2xl border flex flex-col items-center gap-1.5 transition ${
                      currentFontSize === opt.id
                        ? 'border-[#F2A33C] bg-[#F2A33C]/10 text-[#F2A33C] shadow-[0_0_20px_rgba(242,163,60,0.15)]'
                        : 'border-white/10 bg-white/5 text-white/50 hover:border-white/20'
                    }`}
                  >
                    <span className="font-sans text-sm font-bold text-[#F4F0E6]">{opt.label}</span>
                    <span className="font-mono text-xs opacity-70">{opt.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 2. Default Playback Tempo */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <label className="font-sans text-xs sm:text-sm font-semibold text-[#ECEAE4]/80">
                  Default Playback Tempo
                </label>
                <span className="font-mono text-xs sm:text-sm font-bold text-[#F2A33C] px-3 py-1 rounded-lg bg-[#F2A33C]/10 border border-[#F2A33C]/30">
                  {currentDefaultRate.toFixed(1)}×
                </span>
              </div>

              <div className="flex items-center gap-4 bg-white/[0.03] border border-white/5 p-4 rounded-2xl">
                <span className="font-mono text-xs text-[#ECEAE4]/40">0.8×</span>
                <input
                  type="range"
                  aria-label="Default Playback Tempo"
                  min="0.8"
                  max="3.5"
                  step="0.1"
                  value={currentDefaultRate}
                  onChange={(e) => {
                    handleUpdateSettings({ defaultRate: parseFloat(e.target.value) });
                  }}
                  className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#F2A33C]"
                />
                <span className="font-mono text-xs text-[#ECEAE4]/40">3.5×</span>
              </div>
            </div>

            {/* 3. Narrator Voice */}
            <div className="flex flex-col gap-3">
              <label className="font-sans text-xs sm:text-sm font-semibold text-[#ECEAE4]/80 flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-[#F2A33C]" />
                <span>Neural Voice Selection</span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {SONIOX_VOICES.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => {
                      handleUpdateSettings({ sonioxVoice: v.id });
                    }}
                    className={`p-4 rounded-2xl border text-left flex flex-col gap-1.5 transition ${
                      currentSonioxVoice === v.id
                        ? 'border-[#F2A33C] bg-[#F2A33C]/10 text-[#F4F0E6] shadow-[0_0_20px_rgba(242,163,60,0.15)]'
                        : 'border-white/10 bg-white/5 text-white/50 hover:border-white/20'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-sans font-bold text-sm text-[#F4F0E6]">{v.name}</span>
                      {currentSonioxVoice === v.id && <Check className="w-4 h-4 text-[#F2A33C]" />}
                    </div>
                    <span className="font-sans text-xs text-[#ECEAE4]/50">{v.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 4. Kinreader Pro Banner */}
            <div className="rounded-3xl bg-gradient-to-br from-[#1B1D26] to-[#101117] border border-[#F2A33C]/30 p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mt-2">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-[#F2A33C]/10 border border-[#F2A33C]/20 flex items-center justify-center shrink-0">
                  <Sparkles className="w-6 h-6 text-[#F2A33C]" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-serif font-medium text-lg text-[#F4F0E6]">
                      Kinreader Pro
                    </span>
                    <span className="font-mono text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#F2A33C]/15 text-[#F2A33C] border border-[#F2A33C]/30">
                      UNLIMITED
                    </span>
                  </div>
                  <span className="font-sans text-xs text-[#ECEAE4]/50">
                    Unlock full neural synthesis voices, 3.5× tempo acceleration, and priority queue sync.
                  </span>
                </div>
              </div>
              <a
                href="https://buy.stripe.com/eVqfZbgvZeDH6Uc2zJ53O00"
                target="_blank"
                rel="noreferrer"
                className="px-6 py-3 rounded-2xl glow-amber-btn font-sans font-semibold text-xs sm:text-sm transition active:scale-95 shrink-0"
              >
                Start Pro Trial →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Named alias for backwards compatibility
export const LibraryView = LibraryDrawer;
