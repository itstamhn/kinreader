import React, { useState } from 'react';
import { X, Sparkles, Sliders, Type, Volume2, Check } from 'lucide-react';
import type { ReaderSettings } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: ReaderSettings;
  onSaveSettings: (newSettings: ReaderSettings) => void;
}

const SONIOX_VOICES = [
  { id: 'Adrian', name: 'Adrian', desc: 'Warm Narrative (Default)' },
  { id: 'Emma', name: 'Emma', desc: 'Clear & Articulate' },
  { id: 'Alex', name: 'Alex', desc: 'Deep & Authoritative' },
  { id: 'Sophie', name: 'Sophie', desc: 'Engaging & Smooth' },
  { id: 'Oliver', name: 'Oliver', desc: 'Calm & Rhythmic' },
];

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
}: SettingsModalProps) {
  const [defaultRate, setDefaultRate] = useState(settings.defaultRate || 1.5);
  const [fontSize, setFontSize] = useState<'sm' | 'md' | 'lg'>(settings.fontSize || 'md');
  const [sonioxVoice, setSonioxVoice] = useState(settings.sonioxVoice || 'Adrian');

  if (!isOpen) return null;

  const handleSave = () => {
    onSaveSettings({
      ...settings,
      ttsProvider: 'soniox',
      defaultRate,
      fontSize,
      sonioxVoice,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in select-none">
      <div className="w-full max-w-md bg-[#14151C] border border-white/10 rounded-3xl p-6 sm:p-7 shadow-[0_30px_80px_rgba(0,0,0,0.7)] flex flex-col gap-5 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-[#F2A33C]" />
            <h2 className="font-serif font-medium text-xl text-[#F4F0E6]">Settings & Preferences</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-white/10 text-white/50 hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 1. Kinetic Typography Size */}
        <div className="flex flex-col gap-2">
          <label className="font-sans text-xs font-semibold text-[#ECEAE4]/80 flex items-center gap-1.5">
            <Type className="w-3.5 h-3.5 text-[#F2A33C]" />
            <span>Focal Text Scale</span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: 'sm', label: 'Compact', desc: '36px' },
                { id: 'md', label: 'Standard', desc: '46px (Default)' },
                { id: 'lg', label: 'Large', desc: '56px' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                onClick={() => setFontSize(opt.id)}
                className={`p-2.5 rounded-2xl border flex flex-col items-center gap-0.5 transition ${
                  fontSize === opt.id
                    ? 'border-[#F2A33C] bg-[#F2A33C]/10 text-[#F2A33C]'
                    : 'border-white/10 bg-white/5 text-white/50 hover:border-white/20'
                }`}
              >
                <span className="font-sans text-xs font-bold">{opt.label}</span>
                <span className="font-mono text-[9px] opacity-70">{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 2. Playback Tempo Slider (0.8x to 3.5x) */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="font-sans text-xs font-semibold text-[#ECEAE4]/80">Default Playback Tempo</label>
            <span className="font-mono text-xs font-bold text-[#F2A33C] px-2 py-0.5 rounded-lg bg-[#F2A33C]/10 border border-[#F2A33C]/30">
              {defaultRate.toFixed(1)}×
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-[#ECEAE4]/40">0.8×</span>
            <input
              type="range"
              min="0.8"
              max="3.5"
              step="0.1"
              value={defaultRate}
              onChange={(e) => setDefaultRate(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#F2A33C]"
            />
            <span className="font-mono text-[11px] text-[#ECEAE4]/40">3.5×</span>
          </div>
        </div>

        {/* 3. Built-In Neural Voice Selection */}
        <div className="flex flex-col gap-2">
          <label className="font-sans text-xs font-semibold text-[#ECEAE4]/80 flex items-center gap-1.5">
            <Volume2 className="w-3.5 h-3.5 text-[#F2A33C]" />
            <span>Narrator Voice</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {SONIOX_VOICES.map((v) => (
              <button
                key={v.id}
                onClick={() => setSonioxVoice(v.id)}
                className={`p-2.5 rounded-2xl border text-left flex flex-col gap-0.5 transition ${
                  sonioxVoice === v.id
                    ? 'border-[#F2A33C] bg-[#F2A33C]/10 text-[#F4F0E6]'
                    : 'border-white/10 bg-white/5 text-white/50 hover:border-white/20'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-sans font-bold text-xs text-[#F4F0E6]">{v.name}</span>
                  {sonioxVoice === v.id && <Check className="w-3 h-3 text-[#F2A33C]" />}
                </div>
                <span className="font-sans text-[10px] text-[#ECEAE4]/40">{v.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 4. KinReader Pro Section */}
        <div className="rounded-2xl bg-gradient-to-br from-[#1B1D26] to-[#101117] border border-[#F2A33C]/30 p-4 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#F2A33C]" />
              <span className="font-sans font-semibold text-xs text-[#F4F0E6]">KinReader Pro</span>
            </div>
            <span className="font-mono text-[9px] font-bold px-2 py-0.5 rounded-full bg-[#F2A33C]/15 text-[#F2A33C] border border-[#F2A33C]/30">
              UNLIMITED
            </span>
          </div>

          <p className="font-sans text-[11px] text-[#ECEAE4]/60 leading-relaxed">
            Unlock server-managed high-speed neural synthesis, multi-device queue sync, and 9:16 social video export.
          </p>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <a
              href="https://buy.stripe.com/eVqfZbgvZeDH6Uc2zJ53O00"
              target="_blank"
              rel="noreferrer"
              className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-center transition group"
            >
              <div className="font-mono font-bold text-xs text-[#F4F0E6] group-hover:text-[#F2A33C]">$9 / mo</div>
              <div className="font-sans text-[10px] text-[#ECEAE4]/40">Monthly Pro</div>
            </a>

            <a
              href="https://buy.stripe.com/eVqaERcfJeDHbascaj53O01"
              target="_blank"
              rel="noreferrer"
              className="p-2.5 rounded-xl bg-[#F2A33C]/15 hover:bg-[#F2A33C]/25 border border-[#F2A33C]/40 text-center transition group"
            >
              <div className="font-mono font-bold text-xs text-[#F2A33C]">$69 / yr</div>
              <div className="font-sans text-[10px] text-[#F2A33C]/80">Save 36% Yearly</div>
            </a>
          </div>
        </div>

        {/* Save Button */}
        <button
          onClick={handleSave}
          className="w-full h-11 rounded-full glow-amber-btn font-sans font-semibold text-xs transition active:scale-98 mt-1 shrink-0"
        >
          Save Preferences
        </button>
      </div>
    </div>
  );
}
