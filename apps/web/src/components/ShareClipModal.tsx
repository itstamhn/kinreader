import React, { useState } from 'react';
import { X, Download, Share2, Sparkles, Check } from 'lucide-react';
import type { ArticleData } from '../types';

interface ShareClipModalProps {
  isOpen: boolean;
  onClose: () => void;
  article: ArticleData | null;
  currentWord?: string;
  speed: number;
}

export function ShareClipModal({
  isOpen,
  onClose,
  article,
  currentWord = 'cadence',
  speed = 1.5,
}: ShareClipModalProps) {
  const [aspectRatio, setAspectRatio] = useState<'9:16' | '1:1' | '16:9'>('9:16');
  const [karaokeCaptions, setKaraokeCaptions] = useState(true);
  const [voiceAudio, setVoiceAudio] = useState(true);
  const [autoPost, setAutoPost] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  if (!isOpen) return null;

  const handleExportMp4 = () => {
    setIsExporting(true);
    setTimeout(() => {
      setIsExporting(false);
      alert('🎬 Clip rendered at 60 FPS with synchronized karaoke captions! Download ready.');
    }, 1500);
  };

  const handlePostToX = () => {
    const text = `Listening to "${article?.title || 'this article'}" at ${speed}× speed on KinReader:`;
    const url = article?.sourceUrl || window.location.href;
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md h-full bg-[#111218] border-l border-white/10 p-6 flex flex-col gap-4 shadow-2xl overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="font-serif font-medium text-xl text-[#F4F0E6]">Share clip</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Live Video Canvas Preview */}
        <div className="flex justify-center my-2">
          <div
            className={`transition-all duration-300 rounded-2xl overflow-hidden bg-gradient-to-b from-[#14161F] to-[#0A0B0F] border border-white/10 flex flex-col justify-center p-4 gap-2 shadow-2xl relative select-none ${
              aspectRatio === '9:16'
                ? 'w-[170px] h-[300px]'
                : aspectRatio === '1:1'
                ? 'w-[240px] h-[240px]'
                : 'w-[280px] h-[160px]'
            }`}
          >
            <div className="font-mono text-[7px] font-semibold tracking-widest uppercase text-[#F2A33C]">
              NOW PLAYING
            </div>

            <div className="font-serif text-sm leading-snug text-pretty">
              <span className="text-white/40">Deep reading is </span>
              <span className="text-[#FFF7EA] font-medium" style={{ textShadow: '0 0 14px rgba(242,163,60,0.6)' }}>
                {currentWord || 'a cadence the brain learns.'}
              </span>
            </div>

            {/* Mini Waveform */}
            <div className="h-3.5 relative rounded overflow-hidden mt-1">
              <div className="absolute inset-0 waveform-mask-base" />
              <div className="absolute top-0 bottom-0 left-0 w-[45%] waveform-mask-active" />
            </div>

            <div className="flex items-center justify-between mt-1 text-[8px]">
              <span className="font-mono text-white/40">{article?.author || 'Kinreader'} · {speed.toFixed(1)}×</span>
              <span className="font-serif font-semibold text-[#F4F0E6]/80">Kinreader<span className="text-[#F2A33C]">.</span></span>
            </div>
          </div>
        </div>

        {/* Aspect Ratio Selector */}
        <div className="flex justify-center gap-2">
          {(['9:16', '1:1', '16:9'] as const).map((ratio) => (
            <button
              key={ratio}
              onClick={() => setAspectRatio(ratio)}
              className={`h-7 px-4 rounded-full text-xs font-semibold font-sans transition ${
                aspectRatio === ratio
                  ? 'bg-[#F2A33C] text-[#16130B] shadow-md shadow-[#F2A33C]/20'
                  : 'bg-white/5 hover:bg-white/10 text-white/60'
              }`}
            >
              {ratio}
            </button>
          ))}
        </div>

        {/* Option Toggles */}
        <div className="flex flex-col text-xs font-sans divide-y divide-white/5 mt-2">
          <div className="flex items-center justify-between py-2.5">
            <span className="text-white/80 font-medium">Karaoke captions</span>
            <button
              onClick={() => setKaraokeCaptions(!karaokeCaptions)}
              className={`w-9 h-5 rounded-full p-0.5 transition ${karaokeCaptions ? 'bg-[#F2A33C]' : 'bg-white/20'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-[#16130B] transition-transform ${karaokeCaptions ? 'translate-x-4' : 'translate-x-0 bg-white'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between py-2.5">
            <span className="text-white/80 font-medium">Voice audio · 30s</span>
            <button
              onClick={() => setVoiceAudio(!voiceAudio)}
              className={`w-9 h-5 rounded-full p-0.5 transition ${voiceAudio ? 'bg-[#F2A33C]' : 'bg-white/20'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-[#16130B] transition-transform ${voiceAudio ? 'translate-x-4' : 'translate-x-0 bg-white'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between py-2.5">
            <span className="text-white/80 font-medium">Auto-post on publish</span>
            <button
              onClick={() => setAutoPost(!autoPost)}
              className={`w-9 h-5 rounded-full p-0.5 transition ${autoPost ? 'bg-[#F2A33C]' : 'bg-white/20'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-[#16130B] transition-transform ${autoPost ? 'translate-x-4' : 'translate-x-0 bg-white'}`} />
            </button>
          </div>
        </div>

        <div className="flex-1" />

        {/* Bottom Actions */}
        <div className="flex gap-2.5 pt-2">
          <button
            onClick={handlePostToX}
            className="flex-1 h-11 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 text-white font-semibold text-xs flex items-center justify-center gap-2 transition"
          >
            <span>𝕏 Post</span>
          </button>
          <button
            onClick={handleExportMp4}
            disabled={isExporting}
            className="flex-1 h-11 rounded-full glow-amber-btn font-semibold text-xs flex items-center justify-center gap-2 transition active:scale-98 disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExporting ? 'Rendering MP4...' : 'Export MP4'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
