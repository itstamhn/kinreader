import React, { useState } from 'react';
import { Clipboard, Play, Loader2, X } from 'lucide-react';
import type { ArticleData } from '../types';

interface ClipboardDetectSheetProps {
  isOpen: boolean;
  onClose: () => void;
  detectedUrl: string;
  onNarrateNow: (article: ArticleData) => void;
  onAddToQueue: (article: ArticleData) => void;
}

export function ClipboardDetectSheet({
  isOpen,
  onClose,
  detectedUrl,
  onNarrateNow,
  onAddToQueue,
}: ClipboardDetectSheetProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !detectedUrl) return null;

  const isSubstack = /substack/i.test(detectedUrl);
  const isX = /x\.com|twitter\.com/i.test(detectedUrl);
  const dotColor = isSubstack ? '#FF6719' : isX ? '#ECEAE4' : '#5A8DEE';
  const label = isSubstack ? 'Substack Article detected' : isX ? 'X Thread detected' : 'Web Article detected';

  const handleExtract = async (toQueue = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: detectedUrl }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to extract article');
      }

      const data: ArticleData = await res.json();
      if (toQueue) {
        onAddToQueue(data);
      } else {
        onNarrateNow(data);
      }
      onClose();
    } catch (e: any) {
      setError(e.message || 'Extraction failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/65 backdrop-blur-sm animate-fade-in select-none">
      <div className="w-full sm:max-w-md bg-[#14151C] border-t sm:border border-white/10 rounded-t-[28px] sm:rounded-3xl p-5 sm:p-6 pb-safe flex flex-col gap-4 shadow-[0_-20px_60px_rgba(0,0,0,0.6)] animate-slide-up">
        {/* Drag Pill Handle */}
        <div className="w-10 h-1.5 rounded-full bg-white/20 self-center sm:hidden" />

        {/* Header Indicator */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[#F2A33C]">
            <Clipboard className="w-4 h-4" />
            <span className="font-sans font-semibold text-xs">Link on your clipboard</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-white/40 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Detected Preview Card (Design 3c) */}
        <div className="rounded-2xl bg-gradient-to-br from-[#1B1D26] to-[#101117] border border-white/10 p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: dotColor }} />
            <span className="font-sans font-medium text-[11px] text-[#ECEAE4]/60">{label}</span>
          </div>

          <div className="font-serif text-[17px] leading-snug text-[#F4F0E6] truncate">
            {detectedUrl.replace(/^https?:\/\/(www\.)?/, '')}
          </div>

          <div className="flex gap-2 pt-1">
            <span className="h-6 px-2.5 rounded-full bg-[#F2A33C]/15 border border-[#F2A33C]/30 flex items-center font-mono text-[10px] text-[#F2A33C]">
              9 min → 4 min
            </span>
            <span className="h-6 px-2.5 rounded-full bg-white/5 flex items-center font-sans text-[10px] text-[#ECEAE4]/60">
              Soniox v2
            </span>
          </div>
        </div>

        {error && <p className="text-xs text-rose-400 font-sans">{error}</p>}

        {/* Primary CTA: Narrate Now (50px Pill) */}
        <button
          onClick={() => handleExtract(false)}
          disabled={loading}
          className="w-full h-12 rounded-full glow-amber-btn font-sans font-semibold text-sm flex items-center justify-center gap-2 transition active:scale-98 disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-[#16130B]" />
              <span>Extracting & Synthesizing...</span>
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 fill-[#16130B] text-[#16130B]" />
              <span>Narrate now</span>
            </>
          )}
        </button>

        {/* Secondary Links: Add to queue · Dismiss */}
        <div className="flex items-center justify-center gap-6 font-sans text-xs pt-1">
          <button
            onClick={() => handleExtract(true)}
            disabled={loading}
            className="text-[#ECEAE4]/60 hover:text-white font-medium transition"
          >
            Add to queue
          </button>
          <button
            onClick={onClose}
            className="text-[#ECEAE4]/35 hover:text-[#ECEAE4]/70 transition"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
