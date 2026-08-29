import type { WordTiming } from '../types';

// The reactive surface `useSyncExternalStore` subscribes to (plan 018,
// Step 3). One object per change, replaced only when something in it
// actually changed -- see `buildSnapshot`/`notify` below. React calls
// `getSnapshot` on every render; if it ever returned a freshly-allocated
// object instead of this cached reference, React would re-render forever.
export interface PlaybackSnapshot {
  words: WordTiming[];
  duration: number;
  isPlaying: boolean;
  currentWordIndex: number;
  progress: number;
  currentTime: number;
  rate: number;
  mode: 'browser' | 'audio';
}

export class SpeechEngine {
  private audio: HTMLAudioElement | null = null;
  private synth: SpeechSynthesis | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private fullText: string = '';
  private currentWordIdx: number = 0;
  private animFrameId: number | null = null;

  // Playback position/progress, updated at every point the old code used to
  // push them out via `onProgressChange`. Cached rather than derived from
  // `this.audio.currentTime` live so `stop()` and `seek*` can force an exact
  // value (0, or a seek target) independent of whatever the <audio> element
  // reports on the next tick.
  private _currentTime: number = 0;
  private _progress: number = 0;

  private listeners: Set<() => void> = new Set();
  private snapshot: PlaybackSnapshot;

  public words: WordTiming[] = [];
  public duration: number = 0;
  public isPlaying: boolean = false;
  private _rate: number = 1.5;
  public mode: 'browser' | 'audio' = 'browser';

  constructor() {
    if (typeof window !== 'undefined') {
      this.synth = window.speechSynthesis;
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.onended = () => this.handleEnded();
      this.audio.ontimeupdate = () => {
        if (this.audio && !this.audio.paused) {
          this.syncFromAudioTick();
        }
      };
    }
    this.snapshot = this.buildSnapshot();
  }

  public get rate(): number {
    return this._rate;
  }

  // The playback position "now". Exists so callers (e.g. the keyboard
  // shortcut handler) can read it without mirroring it into React state
  // that goes stale the instant it stops being read every frame -- it is
  // kept current at every point that updates `_currentTime` below, which
  // during playback is every animation frame.
  public get currentTime(): number {
    return this._currentTime;
  }

  public set rate(newRate: number) {
    this._rate = Math.max(0.8, Math.min(3.5, Number(newRate.toFixed(2))));

    // 1. Update HTML5 Audio Element playback rate immediately
    if (this.audio) {
      this.audio.playbackRate = this._rate;
      this.audio.defaultPlaybackRate = this._rate;
    }

    // 2. Update Browser Speech Synthesis rate
    if (this.mode === 'browser' && this.synth) {
      if (this.currentUtterance) {
        this.currentUtterance.rate = this._rate;
      }
      // If currently playing in browser mode, seamlessly restart utterance from current position with new rate
      if (this.isPlaying) {
        this.playBrowserFromWord(this.currentWordIdx);
      }
    }

    this.notify();
  }

  public setRate(newRate: number) {
    this.rate = newRate;
  }

  public updateMediaSession(meta: { title: string; author: string; image?: string }) {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title,
        artist: meta.author,
        album: 'Kinreader',
        artwork: meta.image
          ? [{ src: meta.image, sizes: '512x512' }]
          : [{ src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml' }],
      });

      try {
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          const offset = details.seekOffset || 15;
          this.seekToProgress(Math.max(0, (((this.audio?.currentTime || 0) - offset) / (this.duration || 1)) * 100));
        });
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          const offset = details.seekOffset || 15;
          this.seekToProgress(Math.min(100, (((this.audio?.currentTime || 0) + offset) / (this.duration || 1)) * 100));
        });
      } catch {}
    }
  }

  // --- External store surface (React `useSyncExternalStore`) ---------------

  // Register a listener notified whenever the snapshot changes. Returns an
  // unsubscribe function that actually removes it, so components can stop
  // listening on unmount.
  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Must return the SAME reference across calls until something actually
  // changes -- React calls this on every render, and a fresh object each
  // time is an infinite render loop. Only `notify()` ever replaces
  // `this.snapshot`.
  public getSnapshot = (): PlaybackSnapshot => {
    return this.snapshot;
  };

  public getServerSnapshot = (): PlaybackSnapshot => {
    return this.snapshot;
  };

  private buildSnapshot(): PlaybackSnapshot {
    return {
      words: this.words,
      duration: this.duration,
      isPlaying: this.isPlaying,
      currentWordIndex: this.currentWordIdx,
      progress: this._progress,
      currentTime: this._currentTime,
      rate: this._rate,
      mode: this.mode,
    };
  }

  // The single place a new snapshot is allocated and listeners are told
  // about it. Every state-changing operation below ends by calling this
  // instead of pushing through the old three-argument callback API.
  private notify() {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }

  // --- Loading -----------------------------------------------------------

  // Load Cloud Audio from Base64
  public loadAudio(base64: string, words: WordTiming[], duration: number) {
    this.stop();
    this.mode = 'audio';
    this.words = words;
    this.duration = duration;

    if (this.audio) {
      this.audio.src = `data:audio/mp3;base64,${base64}`;
      this.audio.playbackRate = this._rate;
      this.audio.defaultPlaybackRate = this._rate;
    }
    this.notify();
  }

  // Load Audio from direct URL or local asset
  public loadAudioUrl(url: string, words: WordTiming[], duration: number) {
    this.stop();
    this.mode = 'audio';
    this.words = words;
    this.duration = duration;

    if (this.audio) {
      this.audio.src = url;
      this.audio.playbackRate = this._rate;
      this.audio.defaultPlaybackRate = this._rate;
    }
    this.notify();
  }

  // Load Browser On-Device Speech
  public loadBrowserText(text: string, words: WordTiming[]) {
    this.stop();
    this.mode = 'browser';
    this.fullText = text;
    this.words = words;
    const lastWord = words[words.length - 1];
    this.duration = words.length > 0 && lastWord ? lastWord.end : 0;
    this.currentWordIdx = 0;
    this.notify();
  }

  // Update the word list/duration for instant display (e.g. the 0ms-latency
  // estimate shown while the real synthesis request is still in flight) --
  // without touching playback mode, the loaded audio, or resetting position
  // the way loadAudio*/loadBrowserText do via `stop()`.
  public setWordTimings(words: WordTiming[], duration: number) {
    this.words = words;
    this.duration = duration;
    this.notify();
  }

  private playBrowserFromWord(startWordIdx: number) {
    if (!this.synth) return;
    this.synth.cancel();

    const remainingWords = this.words.slice(startWordIdx);
    if (remainingWords.length === 0) {
      this.handleEnded();
      return;
    }

    const remainingText = remainingWords.map((w) => w.text).join(' ');
    const utterance = new SpeechSynthesisUtterance(remainingText);
    utterance.rate = this._rate;

    const voices = this.synth.getVoices();
    const naturalVoice = voices.find(
      (v) => (v.name.includes('Siri') || v.name.includes('Natural') || v.lang.startsWith('en')) && !v.name.includes('compact')
    );
    if (naturalVoice) utterance.voice = naturalVoice;

    utterance.onboundary = (e) => {
      if (e.name === 'word') {
        const spoken = remainingText.substring(0, e.charIndex);
        const deltaWords = spoken.trim() ? spoken.trim().split(/\s+/).length - 1 : 0;
        const currentIdx = Math.min(this.words.length - 1, startWordIdx + deltaWords);
        this.currentWordIdx = currentIdx;

        const currentWordObj = this.words[currentIdx];
        const curTime = currentWordObj ? currentWordObj.start : 0;
        this._currentTime = curTime;
        this._progress = this.duration > 0 ? (curTime / this.duration) * 100 : 0;
        this.notify();
      }
    };

    utterance.onend = () => this.handleEnded();
    this.currentUtterance = utterance;
    this.synth.speak(utterance);
  }

  public play() {
    if (this.isPlaying) return;

    if (this.mode === 'audio' && this.audio) {
      this.audio.playbackRate = this._rate;
      this.audio.defaultPlaybackRate = this._rate;
      this.audio.play().then(() => {
        this.isPlaying = true;
        this.notify();
        this.startSyncLoop();
      }).catch(console.error);
    } else if (this.mode === 'browser') {
      this.isPlaying = true;
      this.notify();
      this.playBrowserFromWord(this.currentWordIdx);
    }
  }

  public pause() {
    if (!this.isPlaying) return;

    if (this.mode === 'audio' && this.audio) {
      this.audio.pause();
    } else if (this.mode === 'browser' && this.synth) {
      this.synth.cancel();
    }

    this.isPlaying = false;
    this.notify();
    this.stopSyncLoop();
  }

  public stop() {
    this.pause();
    if (this.mode === 'browser' && this.synth) {
      this.synth.cancel();
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.src = '';
    }
    this.currentWordIdx = 0;
    this._currentTime = 0;
    this._progress = 0;
    this.notify();
  }

  public seekToWordIndex(wordIndex: number) {
    if (this.words.length === 0) return;
    const safeIdx = Math.max(0, Math.min(this.words.length - 1, wordIndex));
    this.currentWordIdx = safeIdx;
    const targetWord = this.words[safeIdx];
    if (!targetWord) return;

    const targetTime = targetWord.start;
    this._currentTime = targetTime;
    this._progress = this.duration > 0 ? (targetTime / this.duration) * 100 : 0;

    if (this.mode === 'audio' && this.audio) {
      this.audio.currentTime = targetTime;
      this.notify();
    } else if (this.mode === 'browser') {
      this.notify();
      if (this.isPlaying) {
        this.playBrowserFromWord(safeIdx);
      }
    }
  }

  public seekToProgress(percent: number) {
    if (this.duration <= 0) return;
    const clampedPercent = Math.max(0, Math.min(100, percent));
    const targetTime = (clampedPercent / 100) * this.duration;

    let targetWordIdx = 0;
    if (this.words.length > 0) {
      for (let i = 0; i < this.words.length; i++) {
        if (targetTime >= this.words[i]!.start) {
          targetWordIdx = i;
        } else {
          break;
        }
      }
    }

    this.currentWordIdx = targetWordIdx;
    this._currentTime = targetTime;
    this._progress = clampedPercent;

    if (this.mode === 'audio' && this.audio) {
      this.audio.currentTime = targetTime;
      this.notify();
    } else if (this.mode === 'browser') {
      this.notify();
      if (this.isPlaying) {
        this.playBrowserFromWord(targetWordIdx);
      }
    }
  }

  // Shared by the <audio> `ontimeupdate` handler and the rAF sync loop --
  // both used to run the identical scan-for-active-word + push logic.
  private syncFromAudioTick() {
    if (!this.audio) return;
    const curTime = this.audio.currentTime;
    this.duration = this.audio.duration || this.duration || 1;
    const progress = Math.min(100, (curTime / this.duration) * 100);

    let activeIdx = 0;
    for (let i = 0; i < this.words.length; i++) {
      if (curTime >= this.words[i]!.start) {
        activeIdx = i;
      } else {
        break;
      }
    }
    this.currentWordIdx = activeIdx;
    this._currentTime = curTime;
    this._progress = progress;
    this.notify();

    // Update native iOS/macOS lockscreen progress state
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator && this.duration > 0) {
      try {
        navigator.mediaSession.setPositionState?.({
          duration: this.duration,
          playbackRate: this._rate,
          position: Math.min(curTime, this.duration),
        });
      } catch {}
    }
  }

  private startSyncLoop() {
    this.stopSyncLoop();
    const loop = () => {
      if (this.audio && !this.audio.paused) {
        this.syncFromAudioTick();
      }
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  private stopSyncLoop() {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private handleEnded() {
    this.isPlaying = false;
    this._progress = 100;
    this._currentTime = this.duration;
    this.notify();
    this.stopSyncLoop();
  }
}
