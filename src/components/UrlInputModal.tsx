import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X, Link2, FileText, Sparkles, Loader2, Clipboard, Play } from 'lucide-react';
import { useCRPC } from '../lib/convex';
import type { ArticleData } from '../types';

interface UrlInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoadArticle: (article: ArticleData) => void;
  onAddToQueue?: (article: ArticleData) => void;
}

const DEMO_ARTICLE: ArticleData = {
  title: 'Why We Stopped Reading — and how to start again',
  author: 'The Atlantic',
  authorHandle: '@TheAtlantic',
  authorAvatar: 'https://unavatar.io/theatlantic.com',
  image: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=800&q=80',
  sourceUrl: 'https://theatlantic.com/ideas/why-we-stopped-reading',
  sourceType: 'article',
  content: `Deep reading is not a talent — it is a cadence the brain learns, and cadence can be engineered.

When words arrive in clauses, pacing matches comprehension. Attention ceases to be a scattered resource and becomes a directed stream.

We did not lose our capacity for long-form thought. We surrendered the medium that protected it. By synchronizing phonetic speech with luminous focus, reading returns to its natural velocity.`,
};

export function UrlInputModal({
  isOpen,
  onClose,
  onLoadArticle,
  onAddToQueue,
}: UrlInputModalProps) {
  const crpc = useCRPC();
  const extractMutation = useMutation(crpc.routers.articles.extract.mutationOptions());

  const [activeTab, setActiveTab] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState('');
  const [rawText, setRawText] = useState('');
  const [rawTitle, setRawTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.startsWith('http://') || text.startsWith('https://')) {
        setUrl(text);
        setActiveTab('url');
      } else {
        setRawText(text);
        setActiveTab('text');
      }
    } catch {
      // Ignore
    }
  };

  const handleExtractUrl = async (shouldAddToQueue = false) => {
    if (!url.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const data = await extractMutation.mutateAsync({ url: url.trim() });
      if (shouldAddToQueue && onAddToQueue) {
        onAddToQueue(data);
      } else {
        onLoadArticle(data);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Could not load article');
    } finally {
      setLoading(false);
    }
  };

  const handleLoadRawText = (shouldAddToQueue = false) => {
    if (!rawText.trim()) return;
    const article: ArticleData = {
      title: rawTitle.trim() || 'Pasted Note',
      author: 'Custom Text',
      content: rawText.trim(),
      sourceType: 'text',
    };
    if (shouldAddToQueue && onAddToQueue) {
      onAddToQueue(article);
    } else {
      onLoadArticle(article);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in select-none">
      <div className="w-full max-w-[520px] rounded-3xl bg-[#14151C] border border-white/10 shadow-[0_30px_80px_rgba(0,0,0,0.6)] p-6 sm:p-7 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="font-serif font-medium text-xl text-[#F4F0E6]">Add to Kinreader</span>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('url')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-sans font-medium transition ${
              activeTab === 'url' ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white/70'
            }`}
          >
            <Link2 className="w-3.5 h-3.5" />
            <span>Article / Link</span>
          </button>
          <button
            onClick={() => setActiveTab('text')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-sans font-medium transition ${
              activeTab === 'text' ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white/70'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Paste Raw Text</span>
          </button>
        </div>

        {activeTab === 'url' ? (
          <div className="flex flex-col gap-4">
            {/* URL Input Box with Amber Active Border (Design 1c) */}
            <div className="flex items-center gap-2.5 h-12 px-4 rounded-2xl bg-white/5 border border-[#F2A33C]/45 shadow-[0_0_0_3px_rgba(242,163,60,0.08)]">
              <Link2 className="w-4 h-4 text-[#F2A33C] shrink-0" />
              <input
                type="url"
                placeholder="theatlantic.com/ideas/why-we-stopped-reading"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleExtractUrl(false);
                }}
                className="w-full bg-transparent border-none outline-none font-mono text-xs text-[#ECEAE4] placeholder-[#ECEAE4]/30"
              />
              <button
                onClick={handlePasteClipboard}
                className="text-white/40 hover:text-[#F2A33C] transition"
                title="Paste from clipboard"
              >
                <Clipboard className="w-4 h-4" />
              </button>
            </div>

            {error && <p className="text-xs text-rose-400 font-sans">{error}</p>}

            {/* Article Detected Preview Card (Design 1c) */}
            <div className="rounded-2xl bg-gradient-to-br from-[#1B1D26] to-[#101117] border border-white/10 p-4 sm:p-5 flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[#ECEAE4]" />
                <span className="font-sans font-medium text-[11px] text-[#ECEAE4]/60">
                  {url.includes('x.com') ? 'X Thread detected' : 'Article / Essay detected'}
                </span>
              </div>

              <div className="font-serif text-[17px] text-[#F4F0E6] leading-snug">
                {url ? 'Ready to parse and generate kinetic audio' : 'Why We Stopped Reading — and how to start again'}
              </div>

              <div className="flex gap-2 pt-1">
                <span className="h-6 px-2.5 rounded-full bg-[#F2A33C]/15 border border-[#F2A33C]/30 flex items-center font-mono text-[10px] text-[#F2A33C]">
                  14 min → 6 min
                </span>
                <span className="h-6 px-2.5 rounded-full bg-white/5 flex items-center font-sans text-[10px] text-[#ECEAE4]/60">
                  3,120 words
                </span>
                <span className="h-6 px-2.5 rounded-full bg-white/5 flex items-center font-sans text-[10px] text-[#ECEAE4]/60">
                  EN
                </span>
              </div>

              <div className="h-px bg-white/5 my-1" />

              <div className="flex items-center justify-between text-xs font-sans">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#F2A33C] shadow-[0_0_6px_rgba(242,163,60,0.8)]" />
                  <span className="text-[#ECEAE4]/70 font-medium">Soniox v2 · Neural Speech &amp; Whisper Alignment</span>
                </div>
              </div>
            </div>

            {/* Quick Demo Preset Button */}
            <button
              type="button"
              onClick={() => {
                onLoadArticle(DEMO_ARTICLE);
                onClose();
              }}
              className="w-full py-2.5 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-[#F2A33C] font-sans font-semibold flex items-center justify-center gap-2 transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#F2A33C]" />
              <span>⚡ Load Atlantic &quot;Why We Stopped Reading&quot; Demo</span>
            </button>

            {/* Action Buttons (Design 1c) */}
            <div className="flex gap-2.5 pt-1">
              <button
                onClick={() => handleExtractUrl(false)}
                disabled={loading || !url.trim()}
                className="flex-1 h-12 rounded-full glow-amber-btn font-sans font-semibold text-[13px] flex items-center justify-center gap-2 transition active:scale-98 disabled:opacity-40"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-[#16130B]" />
                    <span>Extracting...</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-[#16130B] text-[#16130B]" />
                    <span>Narrate now</span>
                  </>
                )}
              </button>

              <button
                onClick={() => handleExtractUrl(true)}
                disabled={loading || !url.trim()}
                className="flex-1 h-12 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 text-[#ECEAE4]/80 font-sans font-semibold text-[13px] flex items-center justify-center transition active:scale-98 disabled:opacity-40"
              >
                Add to queue
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <input
              type="text"
              placeholder="Title (optional)"
              value={rawTitle}
              onChange={(e) => setRawTitle(e.target.value)}
              className="w-full h-11 px-4 rounded-2xl bg-white/5 border border-white/10 outline-none font-sans text-xs text-[#ECEAE4] placeholder-[#ECEAE4]/30"
            />
            <textarea
              rows={6}
              placeholder="Paste article, thread text or notes here…"
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              className="w-full p-4 rounded-2xl bg-white/5 border border-white/10 outline-none font-sans text-xs text-[#ECEAE4] placeholder-[#ECEAE4]/30 resize-none leading-relaxed"
            />
            <div className="flex gap-2.5 pt-1">
              <button
                onClick={() => handleLoadRawText(false)}
                disabled={!rawText.trim()}
                className="flex-1 h-12 rounded-full glow-amber-btn font-sans font-semibold text-[13px] flex items-center justify-center gap-2 transition active:scale-98 disabled:opacity-40"
              >
                <Play className="w-3.5 h-3.5 fill-[#16130B] text-[#16130B]" />
                <span>Narrate now</span>
              </button>
              <button
                onClick={() => handleLoadRawText(true)}
                disabled={!rawText.trim()}
                className="flex-1 h-12 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 text-[#ECEAE4]/80 font-sans font-semibold text-[13px] flex items-center justify-center transition active:scale-98 disabled:opacity-40"
              >
                Add to queue
              </button>
            </div>
          </div>
        )}

        {/* Footer Tip (Design 1c) */}
        <div className="flex items-center justify-center gap-2 font-sans text-[11px] text-[#ECEAE4]/35 pt-1">
          <span>Tip: paste anywhere in the app with</span>
          <span className="font-mono text-[9px] px-1.5 py-0.5 border border-white/10 rounded text-[#ECEAE4]/50">⌘V</span>
          <span>— detection is instant</span>
        </div>
      </div>
    </div>
  );
}
