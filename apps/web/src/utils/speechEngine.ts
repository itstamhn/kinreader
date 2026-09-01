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
  isStreaming: boolean;
  progressivePlaybackAvailable: boolean;
  playbackReady: boolean;
  authoritativeTimings: boolean;
}

export class SpeechEngine {
  private audio: HTMLAudioElement | null = null;
  private audioErrorHandler: (() => void) | null = null;
  private synth: SpeechSynthesis | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private fullText: string = '';
  private currentWordIdx: number = 0;
  private animFrameId: number | null = null;

  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private pendingAudioChunks: Uint8Array[] = [];
  private allAudioChunks: Uint8Array[] = [];
  private ownedObjectUrl: string | null = null;
  private sourceOpenHandler: (() => void) | null = null;
  private sourceUpdateEndHandler: (() => void) | null = null;
  private sourceErrorHandler: (() => void) | null = null;
  private streamFinishRequested: boolean = false;
  private completedBlobPlaybackInstalled: boolean = false;
  private streamGeneration: number = 0;
  public isStreaming: boolean = false;
  public progressivePlaybackAvailable: boolean = false;
  public playbackReady: boolean = false;
  public authoritativeTimings: boolean = false;

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
      this.audio.onerror = (e) => {
        console.error('[SpeechEngine] Audio element error:', this.audio?.error);
        const handler = this.audioErrorHandler;
        this.audioErrorHandler = null;
        handler?.();
      };
      this.audio.onended = () => this.handleEnded();
      // The real audio duration only becomes knowable once enough of the
      // stream has arrived, and which event delivers it varies by browser --
      // `calibrateToAudioDuration` is a cheap no-op until it is trustworthy.
      this.audio.ondurationchange = () => this.calibrateToAudioDuration();
      this.audio.oncanplaythrough = () => this.calibrateToAudioDuration();
      this.audio.onprogress = () => this.calibrateToAudioDuration();
      this.audio.onsuspend = () => this.calibrateToAudioDuration();
      (window as any).__engine = this;
    }
    this.snapshot = this.buildSnapshot();
  }

  public get rate(): number {
    return this._rate;
  }

  // The index of the word under the highlight right now -- the same value the
  // snapshot carries, exposed so fallbacks can resume from where the listener
  // was rather than from the top of the article.
  public get currentWordIndex(): number {
    return this.currentWordIdx;
  }

  private _muted: boolean = false;

  public get muted(): boolean {
    return this._muted;
  }

  // "Voice off" in the header: the timeline keeps running (the kinetic
  // display is the product), only the sound stops. For the <audio> element
  // that is a property flip; the on-device utterance has to be restarted at
  // volume 0 because SpeechSynthesis reads `volume` once, at `speak()`.
  public set muted(value: boolean) {
    if (this._muted === value) return;
    this._muted = value;
    if (this.audio) this.audio.muted = value;
    if (this.mode === 'browser' && this.isPlaying && this.synth) {
      this.playBrowserFromWord(this.currentWordIdx);
    }
    this.notify();
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
      isStreaming: this.isStreaming,
      progressivePlaybackAvailable: this.progressivePlaybackAvailable,
      playbackReady: this.playbackReady,
      authoritativeTimings: this.authoritativeTimings,
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
    this.playbackReady = true;
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
  public loadAudioUrl(url: string, words: WordTiming[], duration: number, onError?: () => void) {
    this.stop();
    this.audioErrorHandler = onError ?? null;
    this.mode = 'audio';
    this.playbackReady = true;
    this.words = words;
    this.duration = duration;

    if (this.audio) {
      this.audio.src = url;
      this.audio.playbackRate = this._rate;
      this.audio.defaultPlaybackRate = this._rate;
      (this.audio as any).preservesPitch = true;
    }
    this.notify();
  }

  // --- Real-Time Audio Streaming (Soniox WebSocket) -----------------------

  public startStreamingSession(initialWords: WordTiming[], estimatedDuration: number): boolean {
    this.stop();
    const generation = ++this.streamGeneration;
    this.mode = 'audio';
    this.isStreaming = true;
    this.progressivePlaybackAvailable = false;
    this.playbackReady = false;
    this.authoritativeTimings = false;
    this.streamFinishRequested = false;
    this.words = initialWords;
    this.duration = estimatedDuration;
    this.pendingAudioChunks = [];
    this.allAudioChunks = [];

    if (typeof window !== 'undefined') {
      const standardSource = (window as any).MediaSource;
      const managedSource = (window as any).ManagedMediaSource;
      const SourceConstructor =
        typeof standardSource === 'function' && standardSource.isTypeSupported?.('audio/mpeg')
          ? standardSource
          : typeof managedSource === 'function' && managedSource.isTypeSupported?.('audio/mpeg')
            ? managedSource
            : null;

      if (SourceConstructor) {
        try {
          const mediaSource = new SourceConstructor() as MediaSource;
          const isManaged = SourceConstructor === managedSource && SourceConstructor !== standardSource;
          this.mediaSource = mediaSource;
          this.progressivePlaybackAvailable = true;
          this.playbackReady = true;
          if (this.audio) {
            // iOS 17.1+ Safari only offers ManagedMediaSource, and it refuses
            // to open (`sourceopen` never fires, playback stays silent) unless
            // remote playback is disabled on the element first. Standard
            // MediaSource has no such requirement, so AirPlay stays available
            // everywhere else.
            (this.audio as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback =
              isManaged;
            this.ownedObjectUrl = URL.createObjectURL(mediaSource);
            this.audio.src = this.ownedObjectUrl;
            this.audio.playbackRate = this._rate;
            this.audio.defaultPlaybackRate = this._rate;
          }

          this.sourceOpenHandler = () => {
            if (
              generation !== this.streamGeneration ||
              this.mediaSource !== mediaSource ||
              mediaSource.readyState !== 'open'
            ) return;
            try {
              this.sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
              this.sourceUpdateEndHandler = () => {
                this.flushPendingChunks();
              };
              this.sourceErrorHandler = () => {
                this.handleProgressiveSourceFailure(
                  new Error('SourceBuffer reported a non-transient append error')
                );
              };
              this.sourceBuffer.addEventListener('updateend', this.sourceUpdateEndHandler);
              this.sourceBuffer.addEventListener('error', this.sourceErrorHandler);
              this.flushPendingChunks();
            } catch (err) {
              this.handleProgressiveSourceFailure(err);
            }
          };
          mediaSource.addEventListener('sourceopen', this.sourceOpenHandler);
        } catch (err) {
          this.progressivePlaybackAvailable = false;
          this.playbackReady = false;
          this.cleanupStreamingSource();
          console.warn('MediaSource creation error:', err);
        }
      }
    }
    this.notify();
    return this.progressivePlaybackAvailable;
  }

  private flushPendingChunks() {
    if (!this.sourceBuffer || this.sourceBuffer.updating) {
      return;
    }
    const chunk = this.pendingAudioChunks.shift();
    if (chunk) {
      try {
        this.sourceBuffer.appendBuffer(chunk as any);
      } catch (err) {
        this.handleProgressiveSourceFailure(err);
      }
      return;
    }

    if (this.streamFinishRequested && this.mediaSource?.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {}
    }
  }

  public appendAudioChunk(chunk: Uint8Array) {
    if (!this.isStreaming) return;
    this.allAudioChunks.push(chunk);
    if (this.mediaSource) {
      this.pendingAudioChunks.push(chunk);
      this.flushPendingChunks();
    }
  }

  public appendWordTimings(
    newWords: WordTiming[],
    newDuration: number,
    options: { authoritative?: boolean } = {}
  ) {
    this.words = newWords;
    if (options.authoritative) {
      this.authoritativeTimings = true;
    }
    if (newDuration > 0) {
      this.duration = options.authoritative ? newDuration : Math.max(this.duration, newDuration);
    }
    this.notify();
  }

  public finishStreamingSession(): Blob {
    this.isStreaming = false;
    this.streamFinishRequested = true;
    this.flushPendingChunks();

    const blob = new Blob(this.allAudioChunks as any[], { type: 'audio/mpeg' });
    this.installCompletedBlobPlayback(blob);
    this.notify();
    return blob;
  }

  private installCompletedBlobPlayback(blob?: Blob) {
    if (
      this.completedBlobPlaybackInstalled ||
      this.mediaSource ||
      !this.audio ||
      this.allAudioChunks.length === 0
    ) return;

    const completedBlob = blob ?? new Blob(this.allAudioChunks as any[], { type: 'audio/mpeg' });
    this.revokeOwnedObjectUrl();
    this.ownedObjectUrl = URL.createObjectURL(completedBlob);
    this.audio.src = this.ownedObjectUrl;
    this.audio.playbackRate = this._rate;
    this.audio.defaultPlaybackRate = this._rate;
    this.completedBlobPlaybackInstalled = true;
    this.playbackReady = true;
  }

  private handleProgressiveSourceFailure(error: unknown) {
    if (!this.mediaSource && !this.sourceBuffer) return;
    this.progressivePlaybackAvailable = false;
    this.playbackReady = false;
    this.pendingAudioChunks = [];
    if (this.audio && !this.audio.paused) this.audio.pause();
    this.isPlaying = false;
    this.stopSyncLoop();
    this.cleanupStreamingSource();
    if (this.audio && !this.streamFinishRequested) this.audio.src = '';
    if (this.streamFinishRequested) this.installCompletedBlobPlayback();
    this.notify();
    console.warn('Progressive audio source failed; retaining bytes for Blob playback:', error);
  }

  public isSpeechSynthesisSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && !!this.synth;
  }

  // Load Browser On-Device Speech
  public loadBrowserText(text: string, words: WordTiming[]): boolean {
    this.stop();
    this.mode = 'browser';
    this.fullText = text;
    this.words = words;
    const lastWord = words[words.length - 1];
    this.duration = words.length > 0 && lastWord ? lastWord.end : 0;
    this.currentWordIdx = 0;
    this.playbackReady = this.isSpeechSynthesisSupported();
    this.notify();
    return this.playbackReady;
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
    utterance.volume = this._muted ? 0 : 1;

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
    if (this.isPlaying || !this.playbackReady) return;

    if (this.mode === 'audio' && this.audio) {
      this.audio.playbackRate = this._rate;
      this.audio.defaultPlaybackRate = this._rate;
      this.audio.play().then(() => {
        this.isPlaying = true;
        this.notify();
        this.startSyncLoop();
      }).catch(console.error);
    } else if (this.mode === 'browser') {
      if (!this.synth) return;
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
    this.streamGeneration += 1;
    this.cleanupStreamingSource();
    this.audioErrorHandler = null;
    this.pendingAudioChunks = [];
    this.allAudioChunks = [];
    this.isStreaming = false;
    this.progressivePlaybackAvailable = false;
    this.playbackReady = false;
    this.authoritativeTimings = false;
    this.streamFinishRequested = false;
    this.completedBlobPlaybackInstalled = false;
    this.calibrated = false;

    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.src = '';
    }
    this.lastAudioCurrentTime = -1;
    this.currentWordIdx = 0;
    this._currentTime = 0;
    this._progress = 0;
    this.notify();
  }

  private cleanupStreamingSource() {
    if (this.sourceBuffer && this.sourceUpdateEndHandler) {
      try {
        this.sourceBuffer.removeEventListener('updateend', this.sourceUpdateEndHandler);
      } catch {}
    }
    if (this.sourceBuffer && this.sourceErrorHandler) {
      try {
        this.sourceBuffer.removeEventListener('error', this.sourceErrorHandler);
      } catch {}
    }
    if (this.sourceBuffer && this.mediaSource?.readyState === 'open') {
      try {
        this.sourceBuffer.abort();
      } catch {}
    }
    if (this.mediaSource && this.sourceOpenHandler) {
      try {
        this.mediaSource.removeEventListener('sourceopen', this.sourceOpenHandler);
      } catch {}
    }
    if (this.mediaSource?.readyState === 'open') {
      try {
        this.mediaSource.endOfStream();
      } catch {}
    }
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.sourceOpenHandler = null;
    this.sourceUpdateEndHandler = null;
    this.sourceErrorHandler = null;
    this.revokeOwnedObjectUrl();
  }

  private revokeOwnedObjectUrl() {
    if (!this.ownedObjectUrl) return;
    try {
      URL.revokeObjectURL(this.ownedObjectUrl);
    } catch {}
    this.ownedObjectUrl = null;
  }

  public seekToWordIndex(wordIndex: number) {
    if (this.words.length === 0) return;
    const safeIdx = Math.max(0, Math.min(this.words.length - 1, wordIndex));
    this.currentWordIdx = safeIdx;
    const targetWord = this.words[safeIdx];
    if (!targetWord) return;

    const targetTime = targetWord.start;
    this._currentTime = targetTime;
    this.lastAudioCurrentTime = -1;
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
      let low = 0;
      let high = this.words.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (this.words[mid]!.start <= targetTime) {
          targetWordIdx = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
    }

    this.currentWordIdx = targetWordIdx;
    this._currentTime = targetTime;
    this.lastAudioCurrentTime = -1;
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

  private lastAudioCurrentTime: number = -1;

  // How far the highlight may coast ahead of the audio element while the
  // stream is stalled, in media seconds. Big enough that a dropped frame (or a
  // `currentTime` that only ticks every ~50ms) does not visibly stutter the
  // words, small enough that a listener never hears the voice fall behind them.
  private static readonly STALL_COAST_SECONDS = 0.35;

  // HTMLMediaElement.NETWORK_LOADING -- read as a literal because the DOM
  // constant is absent under happy-dom in tests.
  private static readonly NETWORK_LOADING = 2;

  private calibrated: boolean = false;

  // The word timeline `loadAudioUrl` is handed is an estimate (App.tsx builds
  // it at a calibrated ~175 WPM): Soniox's REST endpoint streams raw MP3 and
  // nothing in the response says when each word is actually spoken -- real
  // character timestamps exist only on its WebSocket API. So once the element
  // has the whole file and reports a real duration, stretch the estimate onto
  // it. Without this the highlight drifts further from the voice with every
  // sentence, at any speed.
  private calibrateToAudioDuration() {
    if (this.calibrated || this.authoritativeTimings || !this.audio || this.mode !== 'audio') return;

    const real = this.audio.duration;
    if (!Number.isFinite(real) || real <= 0) return;

    // A chunked MP3 with no Content-Length reports a *growing* duration
    // estimate while it downloads, so only trust the number once the buffer
    // actually covers it and the element has stopped pulling bytes.
    const buffered = this.audio.buffered;
    if (!buffered || buffered.length === 0) return;
    if (buffered.end(buffered.length - 1) < real - 0.25) return;
    if (this.audio.networkState === SpeechEngine.NETWORK_LOADING) return;

    this.calibrated = true;

    const lastWord = this.words[this.words.length - 1];
    const estimated = lastWord ? lastWord.end : 0;
    const scale = estimated > 0 ? real / estimated : 1;

    // Guard the ratio: a wild scale means the estimate and the audio are not
    // the same text (a stale load, a truncated synthesis), and stretching to
    // match it would be worse than leaving the estimate alone. The band is
    // wide because the estimate is genuinely bad on some text: measured
    // against Soniox, prose needs ~1.0x with the recalibrated constants in
    // App.tsx, but number- and acronym-heavy text needs ~2.15x (the voice
    // reads "2026" as four digits with pauses, the heuristic sees one short
    // token). A 2.5 ceiling silently refused to correct exactly the articles
    // that needed it most.
    if (estimated > 0 && scale > 0.3 && scale < 4.0 && Math.abs(scale - 1) > 0.02) {
      this.words = this.words.map((w) => ({
        ...w,
        start: Number((w.start * scale).toFixed(3)),
        end: Number((w.end * scale).toFixed(3)),
      }));
    }

    this.duration = real;
    this.notify();
  }

  // Shared by the rAF sync loop to run the active-word scan + push logic.
  private syncFromAudioTick(dt: number = 0) {
    if (!this.audio || this.mode !== 'audio') return;

    const audioTime = this.audio.currentTime;

    // Keep `duration` honest. This used to be pinned to the estimated word
    // timeline's last `end` on every tick, so whenever that estimate ran short
    // of the real audio the run below hit `curTime >= this.duration` and ended
    // playback while Soniox was still talking.
    const lastWord = this.words[this.words.length - 1];
    const wordsDuration = lastWord ? lastWord.end : 0;
    const realDuration =
      Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : 0;
    this.duration = realDuration || wordsDuration || this.duration;

    // The audio element is the clock, full stop. `currentTime` is media time
    // and the word timings are media time too, so nothing here scales by
    // `_rate`: at 2x the element already advances `currentTime` twice as fast
    // per wall-clock second, which is exactly what the timeline expects.
    const isAudioAdvancing =
      !this.audio.paused &&
      !this.audio.ended &&
      !this.audio.seeking &&
      audioTime !== this.lastAudioCurrentTime;

    let curTime: number;
    if (this.audio.seeking) {
      // Mid-seek `currentTime` can still report the pre-seek position; hold.
      curTime = this._currentTime;
    } else if (isAudioAdvancing) {
      curTime = audioTime;
      this.lastAudioCurrentTime = audioTime;
    } else {
      // Stalled. Above 1x this is routine rather than exceptional, because
      // playback drains the Soniox stream faster than it arrives. Coast a
      // fraction of a second so a dropped frame does not freeze the words,
      // and no further: the old code ran the timeline forward at the full
      // selected rate while the voice stood still, and its `< 2.0s` drift
      // gate then refused to ever re-lock onto the audio -- which is why the
      // text raced permanently ahead of Soniox the moment the speed went up.
      curTime = Math.min(
        audioTime + SpeechEngine.STALL_COAST_SECONDS,
        this._currentTime + dt * this._rate
      );
      curTime = Math.max(curTime, audioTime);

      // The element pauses itself on a buffer underrun. Resume it once it has
      // frames again, rather than seeking it to match our clock the way the
      // old recovery path did -- that dragged the real audio around to fit an
      // estimated timeline.
      if (this.isPlaying && this.audio.paused && !this.audio.ended && this.audio.readyState >= 3) {
        this.audio.play().catch(() => {});
      }
    }

    if (this.duration > 0) {
      curTime = Math.min(curTime, this.duration);
    }

    // Only the audio decides when playback is over. While a chunked stream is
    // still arriving there is no real duration, and the estimate is not
    // evidence of the end -- the highlight simply holds on the last word.
    if (this.audio.ended || (realDuration > 0 && curTime >= realDuration - 0.05)) {
      this.handleEnded();
      return;
    }

    const progress = Math.min(100, (curTime / (this.duration || 1)) * 100);

    let activeIdx = this.currentWordIdx;
    if (activeIdx < this.words.length && curTime >= (this.words[activeIdx]?.start ?? 0)) {
      while (activeIdx + 1 < this.words.length && curTime >= this.words[activeIdx + 1]!.start) {
        activeIdx++;
      }
    } else if (this.words.length > 0) {
      let low = 0;
      let high = this.words.length - 1;
      activeIdx = 0;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (this.words[mid]!.start <= curTime) {
          activeIdx = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
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

  private lastLoopTimestamp: number = 0;

  private startSyncLoop() {
    this.stopSyncLoop();
    this.lastLoopTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();

    const loop = (now: number) => {
      if (this.isPlaying) {
        const currentTimestamp = now || (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const dt = Math.max(0, Math.min(0.1, (currentTimestamp - this.lastLoopTimestamp) / 1000));
        this.lastLoopTimestamp = currentTimestamp;

        if (this.mode === 'audio') {
          this.syncFromAudioTick(dt);
        }
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
    // Stop the element too. It used to keep playing whenever the estimated
    // timeline ran out before the real audio did, leaving Soniox talking over
    // a UI that had already reported the article finished.
    if (this.mode === 'audio' && this.audio && !this.audio.paused) {
      this.audio.pause();
    }
    this.isPlaying = false;
    this._progress = 100;
    this._currentTime = this.duration;
    this.notify();
    this.stopSyncLoop();
  }
}
