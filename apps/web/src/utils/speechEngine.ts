import type { WordTiming } from '../types';
import { concatBytes, scanMp3Frames, mp3DurationSeconds } from './mp3Duration';

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
  /** Playing, but intentionally holding the element until enough audio has streamed in. */
  isBuffering: boolean;
  bufferedSeconds: number;
  bufferedAheadSeconds: number;
  bufferTargetSeconds: number;
  canStartPlayback: boolean;
}

export class SpeechEngine {
  private audio: HTMLAudioElement | null = null;
  private audioErrorHandler: (() => void) | null = null;
  private loadingDeadline: ReturnType<typeof setTimeout> | null = null;
  private clearLoadingDeadline() {
    if (this.loadingDeadline !== null) clearTimeout(this.loadingDeadline);
    this.loadingDeadline = null;
  }

  private watchAudioLoad() {
    this.clearLoadingDeadline();
    if (!this.audioErrorHandler) return;
    const generation = this.streamGeneration;
    this.loadingDeadline = setTimeout(() => {
      if (generation !== this.streamGeneration) return;
      const handler = this.audioErrorHandler;
      this.audioErrorHandler = null;
      handler?.();
    }, 20000);
  }
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
  private streamGeneration: number = 0;

  // --- Progressive playback without MediaSource ("parts" mode) -----------
  //
  // Safari's MediaSource does not accept audio/mpeg and older iPhones have no
  // MediaSource at all. Without it the old engine waited for the *entire*
  // article before Play would enable -- ten-plus minutes on a long piece,
  // which read as "loading forever". Instead the incoming MP3 bytes are cut at
  // frame boundaries into parts of a few dozen seconds, each its own Blob URL,
  // and the element plays them back to back: part N+1 is loaded the moment
  // part N ends. The word timeline stays one continuous clock because media
  // time is `parts[current].start + audio.currentTime`.
  //
  // Ten-second parts keep readiness updates frequent while the startup
  // cushion fills. Each part is decoded independently on these browsers.
  public static FIRST_PART_SECONDS = 10;
  public static PART_SECONDS = 10;
  private partsMode: boolean = false;
  private parts: Array<{ url: string; start: number; duration: number }> = [];
  private partsTotalSeconds: number = 0;
  private pendingPartBytes: Uint8Array[] = [];
  private pendingPartByteLength: number = 0;
  private currentPart: number = -1;
  private partOffset: number = 0;
  private pendingSeekTime: number | null = null;
  private awaitingNextPart: boolean = false;
  private streamComplete: boolean = false;
  private savedSections = false;
  private exactWordCount = 0;
  private pendingResumeWord: number | null = null;
  private pendingPartSeek: number | null = null;
  private playRequest = 0;
  private playRequestPending = false;

  public isStreaming: boolean = false;
  public progressivePlaybackAvailable: boolean = false;
  public playbackReady: boolean = false;
  public authoritativeTimings: boolean = false;
  public isBuffering: boolean = false;

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
      this.audio.onerror = () => {
        this.clearLoadingDeadline();
        console.error('[SpeechEngine] Audio element error:', this.audio?.error);
        const handler = this.audioErrorHandler;
        this.audioErrorHandler = null;
        handler?.();
      };
      this.audio.oncanplay = () => {
        this.clearLoadingDeadline();
        if (this.audioErrorHandler && this.isBuffering) {
          if (this.partsMode) this.maybeResumeFromBuffering();
          else this.isBuffering = false;
          this.notify();
        }
      };
      this.audio.onwaiting = () => {
        if (!this.audioErrorHandler) return;
        this.isBuffering = this.isPlaying;
        this.watchAudioLoad();
        this.notify();
      };
      this.audio.onplaying = () => {
        this.clearLoadingDeadline();
        if (this.audioErrorHandler) this.isBuffering = false;
        this.notify();
      };
      this.audio.onended = () => {
        if (this.savedSections && (!this.audio?.ended || this.audio.seeking || this.pendingPartSeek !== null)) return;
        if (this.partsMode) this.onPartEnded();
        else this.handleEnded();
      };
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

  // Seconds of audio received so far in the current stream, measured from the
  // MP3 frames themselves. Available as soon as the bytes are, unlike the
  // element's `duration`, which lags the end of a MediaSource stream.
  public get receivedAudioSeconds(): number {
    if (this.allAudioChunks.length === 0) return 0;
    return mp3DurationSeconds(concatBytes(this.allAudioChunks));
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
      isBuffering: this.isBuffering,
      bufferedSeconds: this.bufferedEnd(),
      bufferedAheadSeconds: this.bufferedAhead(),
      bufferTargetSeconds: this.bufferTarget(),
      canStartPlayback: this.playbackReady && !this.shouldHoldForBuffer(),
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
    this.watchAudioLoad();
    this.notify();
  }

  // Prepare a minute at the selected speed before starting. After an
  // underrun, refill fifteen seconds instead of repeatedly playing a few frames.
  private static readonly LOW_WATERMARK_SECONDS = 0.5;
  private hasStartedStreamingPlayback = false;

  private bufferedRanges(): TimeRanges | null {
    return (this.sourceBuffer?.buffered ?? this.audio?.buffered ?? null) as TimeRanges | null;
  }

  private bufferedEnd(): number {
    if (this.partsMode) return this.partsTotalSeconds;
    const ranges = this.bufferedRanges();
    if (!ranges || ranges.length === 0) return 0;
    return ranges.end(ranges.length - 1);
  }

  // Media seconds available past the playhead in the range it sits in.
  private bufferedAhead(): number {
    if (!this.audio || this.pendingSeekTime !== null) return 0;
    if (this.partsMode) {
      if (this.currentPart < 0) return 0;
      return Math.max(0, this.partsTotalSeconds - (this.partOffset + this.audio.currentTime));
    }
    const ranges = this.bufferedRanges();
    if (!ranges || ranges.length === 0) return 0;
    const position = this.audio.currentTime;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) - 0.25 <= position && position <= ranges.end(index)) {
        return Math.max(0, ranges.end(index) - position);
      }
    }
    return 0;
  }

  // True while a progressive session still has audio on the way. Once the
  // stream is complete, nothing is worth waiting for.
  private moreAudioExpected(): boolean {
    if (this.partsMode) return !this.streamComplete;
    return this.mediaSource !== null && (this.isStreaming || this.pendingAudioChunks.length > 0 || this.sourceBuffer?.updating === true);
  }

  private bufferTarget(): number {
    if (!this.moreAudioExpected()) return 0;
    const wallSeconds = this.hasStartedStreamingPlayback ? 15 : 60;
    return Math.min(wallSeconds * this._rate, Math.max(0, this.duration - this._currentTime));
  }

  private shouldHoldForBuffer(): boolean {
    return this.pendingResumeWord !== null || (this.moreAudioExpected() && this.bufferedAhead() < this.bufferTarget());
  }

  private enterBuffering() {
    if (this.isBuffering) return;
    this.isBuffering = true;
    this.invalidatePlayRequest();
    if (this.audio && !this.audio.paused) this.audio.pause();
    this.notify();
  }

  private maybeResumeFromBuffering() {
    if (!this.isBuffering || !this.isPlaying || !this.audio) return;
    if (this.partsMode) {
      // Nothing loaded yet, or the element ran off the end of a part: the next
      // part has to exist before there is anything to resume.
      if (this.currentPart < 0 || this.awaitingNextPart) {
        const next = this.currentPart + 1;
        if (!this.parts[next]) return;
        this.loadPart(next, 0);
        this.awaitingNextPart = false;
      }
    }
    if (this.shouldHoldForBuffer()) return;
    this.isBuffering = false;
    this.hasStartedStreamingPlayback = true;
    this.lastAudioCurrentTime = -1;
    this.requestAudioPlay();
    this.notify();
  }

  private resetBufferControl() {
    this.isBuffering = false;
    this.hasStartedStreamingPlayback = false;
  }

  // --- Parts mode internals -------------------------------------------------

  private enablePartsMode() {
    this.partsMode = true;
    this.progressivePlaybackAvailable = true;
    // Playable in the same sense as a MediaSource session: pressing Play
    // before the first part has arrived holds (buffering) and starts on its
    // own, rather than being refused.
    this.playbackReady = true;
  }

  private resetParts() {
    for (const part of this.parts) {
      try {
        URL.revokeObjectURL(part.url);
      } catch {}
    }
    this.partsMode = false;
    this.savedSections = false;
    this.exactWordCount = 0;
    this.pendingResumeWord = null;
    this.pendingPartSeek = null;
    if (this.audio) this.audio.onloadedmetadata = null;
    this.parts = [];
    this.partsTotalSeconds = 0;
    this.pendingPartBytes = [];
    this.pendingPartByteLength = 0;
    this.currentPart = -1;
    this.partOffset = 0;
    this.pendingSeekTime = null;
    this.awaitingNextPart = false;
    this.streamComplete = false;
  }

  // Cut the pending bytes into a part once enough audio has accumulated (or
  // unconditionally at the end of the stream). Cuts land on MP3 frame
  // boundaries so each part decodes on its own.
  private maybeCutPart(force: boolean) {
    if (!this.partsMode || this.pendingPartBytes.length === 0) return;
    const target = this.parts.length === 0 ? SpeechEngine.FIRST_PART_SECONDS : SpeechEngine.PART_SECONDS;
    // ~16 KB/s at 128 kbps: skip the scan until a part could plausibly fit.
    if (!force && this.pendingPartByteLength < target * 12000) return;

    const bytes = concatBytes(this.pendingPartBytes);
    const scan = scanMp3Frames(bytes);
    if (!force && scan.seconds < target) return;

    let partBytes: Uint8Array;
    let remainder: Uint8Array | null;
    if (force || scan.consumedBytes >= bytes.byteLength) {
      partBytes = bytes;
      remainder = null;
    } else {
      partBytes = bytes.slice(0, scan.consumedBytes);
      remainder = bytes.slice(scan.consumedBytes);
    }
    this.pendingPartBytes = remainder && remainder.byteLength > 0 ? [remainder] : [];
    this.pendingPartByteLength = remainder?.byteLength ?? 0;
    if (partBytes.byteLength === 0) return;
    this.addPart(partBytes, force ? scan.seconds : Math.min(scan.seconds, scanMp3Frames(partBytes).seconds));
  }

  private addPart(bytes: Uint8Array, seconds: number) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/mpeg' }));
    this.parts.push({ url, start: this.partsTotalSeconds, duration: seconds });
    this.partsTotalSeconds += seconds;
    this.playbackReady = true;
    if (this.currentPart < 0) {
      this.loadPart(0, 0);
    }
    // Waiting listeners (Play pressed before the first part, or the element
    // ran off the end of the last available part) can move on now.
    this.applyPendingSeek();
    this.maybeResumeFromBuffering();
    this.notify();
  }

  private loadPart(index: number, offsetWithin: number) {
    const part = this.parts[index];
    if (!part || !this.audio) return;
    this.invalidatePlayRequest();
    this.currentPart = index;
    this.partOffset = part.start;
    if (this.savedSections) {
      this.pendingPartSeek = offsetWithin;
      const generation = this.streamGeneration;
      this.audio.onloadedmetadata = () => {
        if (generation !== this.streamGeneration || this.currentPart !== index || !this.audio) return;
        const target = this.pendingPartSeek;
        this.pendingPartSeek = null;
        if (target !== null) this.audio.currentTime = target;
        this.maybeResumeFromBuffering();
      };
    }
    this.audio.src = part.url;
    this.audio.playbackRate = this._rate;
    this.audio.defaultPlaybackRate = this._rate;
    this.audio.currentTime = offsetWithin;
    this.watchAudioLoad();
    this.lastAudioCurrentTime = -1;
  }

  private onPartEnded() {
    const next = this.currentPart + 1;
    if (this.parts[next]) {
      this.loadPart(next, 0);
      if (this.isPlaying && !this.isBuffering) this.requestAudioPlay();
      return;
    }
    if (this.streamComplete) {
      this.handleEnded();
      return;
    }
    // Ran off the end of what has arrived: hold until the next part lands.
    this.awaitingNextPart = true;
    if (this.isPlaying) this.enterBuffering();
  }

  // Position the element at a point on the continuous timeline, loading the
  // part that contains it when it is not the current one.
  private applyPendingSeek() {
    const target = this.pendingSeekTime;
    const end = this.bufferedEnd();
    if (this.pendingResumeWord !== null || target === null || end <= 0 || (target >= end && this.moreAudioExpected())) return;
    this.pendingSeekTime = null;
    const resolved = Math.min(target, Math.max(0, end - 0.05));
    this.seekToProgress(this.duration > 0 ? resolved / this.duration * 100 : 0);
  }

  private seekAudioTo(targetTime: number) {
    if (!this.audio) return;
    // A resume position may arrive before its audio. Remember it rather than
    // silently clamping Safari to the last part or seeking MSE into an empty range.
    if (this.moreAudioExpected() && targetTime > 0 && targetTime >= this.bufferedEnd()) {
      this.pendingSeekTime = targetTime;
      if (this.isPlaying) this.enterBuffering();
      return;
    }
    this.pendingSeekTime = null;
    if (!this.partsMode) {
      this.audio.currentTime = targetTime;
      return;
    }
    if (this.parts.length === 0) return;
    const clamped = Math.max(0, Math.min(targetTime, Math.max(0, this.partsTotalSeconds - 0.05)));
    let index = this.parts.length - 1;
    for (let i = 0; i < this.parts.length; i += 1) {
      const part = this.parts[i]!;
      if (clamped < part.start + part.duration) {
        index = i;
        break;
      }
    }
    const within = Math.max(0, clamped - this.parts[index]!.start);
    this.awaitingNextPart = false;
    if (index !== this.currentPart) {
      this.loadPart(index, within);
      if (this.isPlaying && !this.isBuffering) this.requestAudioPlay();
    } else {
      if (this.pendingPartSeek !== null) this.pendingPartSeek = within;
      this.audio.currentTime = within;
    }
  }

  /** Saved MP3s are independent recordings. Keep their headers and seek tables
   * intact instead of concatenating them into a browser SourceBuffer. */
  public startSavedSections(words: WordTiming[], duration: number, resumeWordIndex = 0, onError?: () => void) {
    this.stop();
    this.mode = 'audio';
    this.isStreaming = true;
    this.words = words;
    this.duration = duration;
    this.savedSections = true;
    this.audioErrorHandler = onError ?? null;
    this.pendingResumeWord = resumeWordIndex > 0 ? Math.min(words.length - 1, resumeWordIndex) : null;
    if (this.pendingResumeWord !== null) {
      this.currentWordIdx = this.pendingResumeWord;
      this._currentTime = words[this.currentWordIdx]?.start ?? 0;
      this._progress = duration > 0 ? this._currentTime / duration * 100 : 0;
    }
    this.enablePartsMode();
    this.notify();
  }

  public appendSavedSection(bytes: Uint8Array, duration: number, wordCount: number) {
    if (!this.savedSections || !this.isStreaming) return;
    this.exactWordCount += wordCount;
    this.addPart(bytes, duration);
    if (this.pendingResumeWord !== null && this.pendingResumeWord < this.exactWordCount) {
      const word = this.pendingResumeWord;
      this.pendingResumeWord = null;
      this.seekToWordIndex(word);
    }
    this.maybeResumeFromBuffering();
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
    this.resetBufferControl();
    this.resetParts();

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
              this.clearLoadingDeadline();
              this.sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
              this.sourceUpdateEndHandler = () => {
                this.flushPendingChunks();
                this.applyPendingSeek();
                this.maybeResumeFromBuffering();
                this.notify();
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
          this.loadingDeadline = setTimeout(() => {
            if (generation === this.streamGeneration && !this.sourceBuffer) {
              this.handleProgressiveSourceFailure(new Error('Audio source did not open'));
            }
          }, 8000);
        } catch (err) {
          this.progressivePlaybackAvailable = false;
          this.playbackReady = false;
          this.cleanupStreamingSource();
          console.warn('MediaSource creation error:', err);
        }
      }
      // No usable MediaSource (Safari, older iOS): play in parts instead of
      // waiting for the whole article.
      if (!this.mediaSource) this.enablePartsMode();
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
    } else if (this.partsMode) {
      this.pendingPartBytes.push(chunk);
      this.pendingPartByteLength += chunk.byteLength;
      this.maybeCutPart(false);
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
    if (this.partsMode) {
      // Whatever is left becomes the final part; the whole track is now here.
      this.maybeCutPart(true);
      this.streamComplete = true;
      if (this.awaitingNextPart && this.parts[this.currentPart + 1]) {
        this.awaitingNextPart = false;
        this.loadPart(this.currentPart + 1, 0);
        if (this.isPlaying) this.requestAudioPlay();
      } else if (this.awaitingNextPart) {
        // Ended on the last part while waiting for more: that was the end.
        this.awaitingNextPart = false;
        this.handleEnded();
      }
    }
    this.applyPendingSeek();
    this.maybeResumeFromBuffering();
    this.notify();
    return blob;
  }

  private handleProgressiveSourceFailure(error: unknown) {
    if (!this.mediaSource && !this.sourceBuffer) return;
    const wasPlaying = this.isPlaying;
    const resumeTime = this._currentTime;
    this.progressivePlaybackAvailable = false;
    this.playbackReady = false;
    this.pendingAudioChunks = [];
    this.resetBufferControl();
    if (this.audio && !this.audio.paused) this.audio.pause();
    this.isPlaying = false;
    this.stopSyncLoop();
    this.cleanupStreamingSource();
    if (this.audio) this.clearAudioSource();
    // Carry on in parts with everything received so far; the stream keeps
    // feeding appendAudioChunk, which now cuts parts instead of appending.
    this.enablePartsMode();
    this.pendingPartBytes = [...this.allAudioChunks];
    this.pendingPartByteLength = this.allAudioChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    this.maybeCutPart(this.streamFinishRequested);
    if (this.streamFinishRequested) this.streamComplete = true;
    this.seekAudioTo(resumeTime);
    if (wasPlaying) this.play();
    this.notify();
    console.warn('Progressive audio source failed; continuing in parts:', error);
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

  private invalidatePlayRequest() {
    this.playRequest++;
    this.playRequestPending = false;
  }

  private requestAudioPlay() {
    if (!this.audio || !this.isPlaying || this.playRequestPending) return;
    const request = ++this.playRequest;
    this.playRequestPending = true;
    this.audio.play().then(() => {
      if (request !== this.playRequest) return;
      this.playRequestPending = false;
      this.hasStartedStreamingPlayback = true;
      this.notify();
    }).catch(() => {
      if (request !== this.playRequest) return;
      this.playRequestPending = false;
      this.isPlaying = false;
      this.isBuffering = false;
      this.stopSyncLoop();
      this.notify();
    });
  }

  public play() {
    if (this.isPlaying || !this.playbackReady) return;

    if (this.mode === 'audio' && this.audio) {
      if (this._progress >= 100) this.seekToProgress(0);
      this.audio.playbackRate = this._rate;
      this.audio.defaultPlaybackRate = this._rate;
      // Record intent synchronously. Source changes and Pause invalidate the
      // promise so an earlier Play cannot control a later source or seek.
      this.isPlaying = true;
      this.isBuffering = this.shouldHoldForBuffer();
      if (!this.isBuffering) this.requestAudioPlay();
      this.notify();
      this.startSyncLoop();
    } else if (this.mode === 'browser') {
      if (!this.synth) return;
      this.isPlaying = true;
      this.notify();
      this.playBrowserFromWord(this.currentWordIdx);
    }
  }

  public pause() {
    this.invalidatePlayRequest();

    if (this.mode === 'audio' && this.audio) {
      this.audio.pause();
    } else if (this.mode === 'browser' && this.synth) {
      this.synth.cancel();
    }

    this.isPlaying = false;
    this.isBuffering = false;
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
    this.calibrated = false;
    this.resetBufferControl();
    this.resetParts();

    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.clearAudioSource();
    }
    this.lastAudioCurrentTime = -1;
    this.currentWordIdx = 0;
    this._currentTime = 0;
    this._progress = 0;
    this.notify();
  }

  private clearAudioSource() {
    if (!this.audio) return;
    if (this.audio.removeAttribute) {
      this.audio.removeAttribute('src');
      this.audio.load();
    } else {
      this.audio.src = '';
    }
  }

  private cleanupStreamingSource() {
    this.clearLoadingDeadline();
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
    this.pendingResumeWord = this.savedSections && safeIdx >= this.exactWordCount ? safeIdx : null;
    this.currentWordIdx = safeIdx;
    const targetWord = this.words[safeIdx];
    if (!targetWord) return;

    const targetTime = targetWord.start;
    this._currentTime = targetTime;
    this.lastAudioCurrentTime = -1;
    this._progress = this.duration > 0 ? (targetTime / this.duration) * 100 : 0;

    if (this.mode === 'audio' && this.audio) {
      this.seekAudioTo(targetTime);
      this.maybeResumeFromBuffering();
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
    this.pendingResumeWord = null;
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
      this.seekAudioTo(targetTime);
      this.maybeResumeFromBuffering();
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
    if (this.calibrated || this.authoritativeTimings || this.partsMode || !this.audio || this.mode !== 'audio') return;

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
    if (this.pendingSeekTime !== null || this.pendingResumeWord !== null || this.pendingPartSeek !== null) return;

    // In parts mode the element only knows its current part; the timeline is
    // the part's start plus the element's position.
    const audioTime = this.partOffset + this.audio.currentTime;

    // Streaming buffer control: refill when the cushion is gone, resume once
    // it is back (or the stream has finished and there is nothing to wait for).
    if (this.isBuffering) {
      this.maybeResumeFromBuffering();
    } else if (
      this.moreAudioExpected() &&
      !this.audio.paused &&
      this.bufferedAhead() < SpeechEngine.LOW_WATERMARK_SECONDS
    ) {
      this.enterBuffering();
    }

    // Keep `duration` honest. This used to be pinned to the estimated word
    // timeline's last `end` on every tick, so whenever that estimate ran short
    // of the real audio the run below hit `curTime >= this.duration` and ended
    // playback while Soniox was still talking.
    const lastWord = this.words[this.words.length - 1];
    const wordsDuration = lastWord ? lastWord.end : 0;
    const realDuration = this.partsMode
      ? this.streamComplete
        ? this.partsTotalSeconds
        : 0
      : Number.isFinite(this.audio.duration) && this.audio.duration > 0
        ? this.audio.duration
        : 0;
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
      if (
        this.isPlaying &&
        !this.isBuffering &&
        this.audio.paused &&
        !this.audio.ended &&
        this.audio.readyState >= 3
      ) {
        this.requestAudioPlay();
      }
    }

    if (this.duration > 0) {
      curTime = Math.min(curTime, this.duration);
    }

    // Only the audio decides when playback is over. While a chunked stream is
    // still arriving there is no real duration, and the estimate is not
    // evidence of the end -- the highlight simply holds on the last word.
    // In parts mode `ended` is a part boundary, handled by onPartEnded.
    if (!this.partsMode && (this.audio.ended || (realDuration > 0 && curTime >= realDuration - 0.05))) {
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
    this.invalidatePlayRequest();
    this.isBuffering = false;
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
