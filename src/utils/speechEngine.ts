import type { WordTiming } from '../types';

export class SpeechEngine {
  private audio: HTMLAudioElement | null = null;
  private synth: SpeechSynthesis | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private fullText: string = '';
  private currentWordIdx: number = 0;
  private onWordChange: (index: number) => void = () => {};
  private onProgressChange: (progress: number, currentTime: number, duration: number) => void = () => {};
  private onStateChange: (isPlaying: boolean) => void = () => {};
  private animFrameId: number | null = null;

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
          const curTime = this.audio.currentTime;
          const dur = this.audio.duration || this.duration || 1;
          const progress = Math.min(100, (curTime / dur) * 100);
          
          let activeIdx = 0;
          for (let i = 0; i < this.words.length; i++) {
            if (curTime >= this.words[i]!.start) {
              activeIdx = i;
            } else {
              break;
            }
          }
          this.currentWordIdx = activeIdx;
          if (this.words.length > 0) {
            this.onWordChange(activeIdx);
          }
          this.onProgressChange(progress, curTime, dur);

          // Update native iOS/macOS lockscreen progress state
          if (typeof navigator !== 'undefined' && 'mediaSession' in navigator && dur > 0) {
            try {
              navigator.mediaSession.setPositionState?.({
                duration: dur,
                playbackRate: this._rate,
                position: Math.min(curTime, dur),
              });
            } catch {}
          }
        }
      };
    }
  }

  public get rate(): number {
    return this._rate;
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

  public setCallbacks(
    onWord: (index: number) => void,
    onProgress: (progress: number, currentTime: number, duration: number) => void,
    onState: (isPlaying: boolean) => void
  ) {
    this.onWordChange = onWord;
    this.onProgressChange = onProgress;
    this.onStateChange = onState;
  }

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
  }

  // Load Browser On-Device Speech
  public loadBrowserText(text: string, words: WordTiming[]) {
    this.stop();
    this.mode = 'browser';
    this.fullText = text;
    this.words = words;
    this.duration = words.length > 0 ? words[words.length - 1].end : 0;
    this.currentWordIdx = 0;
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
        this.onWordChange(currentIdx);

        const currentWordObj = this.words[currentIdx];
        const curTime = currentWordObj ? currentWordObj.start : 0;
        const progress = this.duration > 0 ? (curTime / this.duration) * 100 : 0;
        this.onProgressChange(progress, curTime, this.duration);
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
        this.onStateChange(true);
        this.startSyncLoop();
      }).catch(console.error);
    } else if (this.mode === 'browser') {
      this.isPlaying = true;
      this.onStateChange(true);
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
    this.onStateChange(false);
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
    this.onWordChange(0);
    this.onProgressChange(0, 0, this.duration);
  }

  public seekToWordIndex(wordIndex: number) {
    if (this.words.length === 0) return;
    const safeIdx = Math.max(0, Math.min(this.words.length - 1, wordIndex));
    this.currentWordIdx = safeIdx;
    const targetWord = this.words[safeIdx];
    if (!targetWord) return;

    const targetTime = targetWord.start;
    const progress = this.duration > 0 ? (targetTime / this.duration) * 100 : 0;

    if (this.mode === 'audio' && this.audio) {
      this.audio.currentTime = targetTime;
      this.onWordChange(safeIdx);
      this.onProgressChange(progress, targetTime, this.duration);
    } else if (this.mode === 'browser') {
      this.onWordChange(safeIdx);
      this.onProgressChange(progress, targetTime, this.duration);
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

    if (this.mode === 'audio' && this.audio) {
      this.audio.currentTime = targetTime;
      this.onWordChange(targetWordIdx);
      this.onProgressChange(clampedPercent, targetTime, this.duration);
    } else if (this.mode === 'browser') {
      this.onWordChange(targetWordIdx);
      this.onProgressChange(clampedPercent, targetTime, this.duration);
      if (this.isPlaying) {
        this.playBrowserFromWord(targetWordIdx);
      }
    }
  }

  private startSyncLoop() {
    this.stopSyncLoop();
    const loop = () => {
      if (this.audio && !this.audio.paused) {
        const curTime = this.audio.currentTime;
        const dur = this.audio.duration || this.duration || 1;
        const progress = Math.min(100, (curTime / dur) * 100);

        let activeIdx = 0;
        for (let i = 0; i < this.words.length; i++) {
          if (curTime >= this.words[i]!.start) {
            activeIdx = i;
          } else {
            break;
          }
        }
        this.currentWordIdx = activeIdx;
        if (this.words.length > 0) {
          this.onWordChange(activeIdx);
        }
        this.onProgressChange(progress, curTime, dur);
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
    this.onStateChange(false);
    this.stopSyncLoop();
    this.onProgressChange(100, this.duration, this.duration);
  }
}
