import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Header } from './components/Header';
import { KineticDisplay } from './components/KineticDisplay';
import { Controls } from './components/Controls';
import { UrlInputModal } from './components/UrlInputModal';
import { SettingsModal } from './components/SettingsModal';
import { LibraryDrawer, type SavedArticleItem } from './components/LibraryDrawer';
import { AuthModal, type UserProfile } from './components/AuthModal';
import { ClipboardDetectSheet } from './components/ClipboardDetectSheet';
import { SpeechEngine } from './utils/speechEngine';
import { SAMPLE_ARTICLE, SAMPLE_TIMINGS, SAMPLE_DURATION } from './data/sampleData';
import {
  getSavedArticles,
  saveArticleToLibrary,
  deleteArticleFromLibrary,
  getOrCreateClientId,
} from './lib/storage';
import { useCRPC } from './lib/convex';
import { authClient } from './lib/auth-client';
import type { ArticleData, ReaderSettings, WordTiming } from './types';

const DEFAULT_SETTINGS: ReaderSettings = {
  ttsProvider: 'soniox',
  sonioxApiKey: '',
  sonioxVoice: 'Adrian',
  groqApiKey: '',
  elevenApiKey: '',
  elevenVoiceId: '21m00Tcm4TlvDq8ikWAM',
  defaultRate: 1.5,
};

// The states article loading moves through. Replaces the old loading
// boolean, which could only say "loading" or "not" and had no way to
// represent a synthesis failure -- the reader could not tell a neural voice
// from a silent fallback to the on-device one (plan 018, Step 4).
type PlaybackStatus =
  | 'idle' // sample article, nothing loaded
  | 'timing' // instant word timings computed, audio not yet requested
  | 'synthesizing' // waiting on the Convex TTS action
  | 'ready' // neural audio loaded
  | 'degraded' // synthesis failed; on-device speech instead
  | 'error'; // nothing playable

export function App() {
  const crpc = useCRPC();
  const extractArticleMutation = useMutation(crpc.routers.articles.extract.mutationOptions());
  const synthesizeTtsMutation = useMutation(crpc.routers.tts.synthesize.mutationOptions());

  const { data: session } = authClient.useSession();
  const user: UserProfile | null = session?.user
    ? {
        name: session.user.name,
        email: session.user.email,
        avatar: session.user.image || undefined,
        tier: 'pro',
      }
    : null;

  const [article, setArticle] = useState<ArticleData>(SAMPLE_ARTICLE);
  const [savedArticles, setSavedArticles] = useState<SavedArticleItem[]>(() => getSavedArticles());
  const [settings, setSettings] = useState<ReaderSettings>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('kinetic_reader_settings');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          return {
            ...DEFAULT_SETTINGS,
            ...parsed,
            ttsProvider: 'soniox',
          };
        } catch {}
      }
    }
    return DEFAULT_SETTINGS;
  });

  // Prototype States: Clause segmentation length, Voice toggle, and Ramp mode
  const [clauseLength, setClauseLength] = useState<4 | 6 | 9>(6);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);
  const [isRampEnabled, setIsRampEnabled] = useState(false);

  const [viewMode, setViewMode] = useState<'kinetic' | 'full'>('kinetic');

  // Modals & Bottom Sheets State
  const [isInputOpen, setIsInputOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>('idle');
  const [detectedClipboardUrl, setDetectedClipboardUrl] = useState<string>('');

  // The engine is constructed once, lazily, on the first render rather than
  // inside an effect: `useSyncExternalStore` needs `subscribe`/`getSnapshot`
  // bound to a real instance starting with that very first render. This is
  // the standard "lazy ref initialization" pattern and is StrictMode-safe --
  // a duplicate instance from a double-render is simply discarded, never
  // assigned to the ref.
  const engineRef = useRef<SpeechEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new SpeechEngine();
  }
  const engine = engineRef.current;

  // The engine owns playback state -- words, duration, isPlaying,
  // currentWordIndex, progress, currentTime, rate, mode -- and React only
  // subscribes to it. Any future `useState` that shadows one of these
  // fields is plan 018's Bug 1 or Bug 2 returning.
  const playback = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getServerSnapshot);

  // `isRampEnabled` is read fresh from a ref (not a render-time closure) by
  // the ramp effect below, so toggling it never has to be a dependency of
  // an effect that would otherwise need to re-run for unrelated reasons.
  const isRampEnabledRef = useRef(isRampEnabled);
  useEffect(() => {
    isRampEnabledRef.current = isRampEnabled;
  }, [isRampEnabled]);

  const handleTogglePlay = () => {
    // Read play/pause state from the engine itself, not a React mirror --
    // this is what lets the keyboard effect below subscribe once instead of
    // needing playback state in its dependency array.
    if (engine.isPlaying) {
      engine.pause();
    } else {
      engine.play();
    }
  };

  // The only place `engine.rate` is written (done criterion of plan 018).
  const handleSpeedChange = (newSpeed: number) => {
    const clamped = Math.max(0.8, Math.min(3.5, Number(newSpeed.toFixed(2))));
    engine.rate = clamped;
  };

  const handleSeekProgress = (percent: number) => {
    engine.seekToProgress(percent);
  };

  const handleSelectWord = (wordIndex: number) => {
    engine.seekToWordIndex(wordIndex);
  };

  // Load article audio with Soniox v2
  const loadArticleContent = async (art: ArticleData, eng: SpeechEngine, currSettings: ReaderSettings) => {
    eng.stop();
    eng.updateMediaSession({ title: art.title, author: art.author || 'Author', image: art.image });

    const articleKey = art.sourceUrl || art.title;

    if (art.title === SAMPLE_ARTICLE.title) {
      eng.loadAudioUrl('/sample_audio.mp3', SAMPLE_TIMINGS, SAMPLE_DURATION);
      setPlaybackStatus('ready');
      return;
    }

    // 1. Initial word timings for instant kinetic display (0ms UI latency)
    const wordsList = art.content.split(/\s+/).filter(Boolean);
    let curTime = 0;
    const initialWordTimings: WordTiming[] = wordsList.map((w) => {
      const start = curTime;
      const d = Math.max(0.18, Math.min(0.55, w.length * 0.048));
      const end = start + d;
      curTime = end;
      return { text: w, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
    });

    eng.setWordTimings(initialWordTimings, Number(curTime.toFixed(3)));
    setPlaybackStatus('timing');

    // 2. Synthesize via the Convex TTS action (Soniox v2 + Groq alignment,
    // server-side cached by articleId+voice+speed -- see
    // convex/routers/tts.ts). Bounded by the same ~9s budget the old
    // fetch's AbortSignal.timeout used, so a slow/unreachable deployment
    // still falls through to instant on-device speech below.
    setPlaybackStatus('synthesizing');
    try {
      const result = await Promise.race([
        synthesizeTtsMutation.mutateAsync({
          url: articleKey,
          title: art.title,
          author: art.author,
          text: art.content,
          voice: currSettings.sonioxVoice || 'Adrian',
          speed: 1.0,
          sonioxApiKey: currSettings.sonioxApiKey || undefined,
          groqApiKey: currSettings.groqApiKey || undefined,
          clientId: getOrCreateClientId(),
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('TTS request timed out')), 9000);
        }),
      ]);

      if ('audioUrl' in result && result.audioUrl && result.words && result.words.length > 0) {
        eng.loadAudioUrl(result.audioUrl, result.words, result.duration || curTime);
        setPlaybackStatus('ready');
        return;
      }
    } catch (err) {
      console.warn('Soniox neural synthesis fallback:', err);
    }

    // 3. Fallback to device speech only if offline or synthesis fails.
    // Surfaced to the reader as 'degraded' rather than silently swapped --
    // previously this was indistinguishable from a normal neural playback.
    eng.loadBrowserText(art.content, initialWordTimings);
    setPlaybackStatus('degraded');
  };

  const handleLoadNewArticle = (newArticle: ArticleData) => {
    setArticle(newArticle);
    saveArticleToLibrary(newArticle);
    setSavedArticles(getSavedArticles());
    loadArticleContent(newArticle, engine, settings);
  };

  const handleDeleteArticle = (id: string) => {
    deleteArticleFromLibrary(id);
    const updated = getSavedArticles();
    setSavedArticles(updated);

    // If the deleted article was the currently active one, load the next or fallback to sample
    if (article.sourceUrl === id || article.title === id || id === 'sample_article_default') {
      if (updated.length > 0) {
        handleLoadNewArticle(updated[0]!.article);
      } else {
        handleLoadNewArticle(SAMPLE_ARTICLE);
      }
    }
  };

  const handleSaveSettings = (newSettings: ReaderSettings) => {
    setSettings(newSettings);
    localStorage.setItem('kinetic_reader_settings', JSON.stringify(newSettings));
    if (newSettings.defaultRate && Math.abs(newSettings.defaultRate - playback.rate) > 0.05) {
      handleSpeedChange(newSettings.defaultRate);
    }
  };

  // Pre-load the sample audio once on mount. The engine itself is
  // constructed above (once, lazily), so this effect only owns applying the
  // user's saved default rate, the initial load, and the stop-on-unmount
  // cleanup -- it never depends on anything that would otherwise tear the
  // engine down (plan 018, Bug 1). The rate is applied through
  // `handleSpeedChange` rather than written here directly, so
  // `engine.rate` has exactly one call site in this file.
  useEffect(() => {
    handleSpeedChange(settings.defaultRate || 1.5);
    engine.loadAudioUrl('/sample_audio.mp3', SAMPLE_TIMINGS, SAMPLE_DURATION);
    setPlaybackStatus('ready');
    return () => {
      engine.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on
    // mount; `engine` is a stable ref-held singleton for the component's
    // lifetime, and only the initial `settings` value should seed the rate.
  }, [engine]);

  // Automatic ramp handling: nudge the rate up every 12 words while ramp
  // mode is on. Triggered by an actual word-index change -- matching the
  // original in-engine-callback behavior exactly -- and reads the ramp flag
  // fresh from the ref so toggling ramp on/off never itself fires a bump.
  useEffect(() => {
    if (!isRampEnabledRef.current) return;
    const idx = playback.currentWordIndex;
    if (idx > 0 && idx % 12 === 0) {
      handleSpeedChange(Math.min(3.5, Number((engine.rate + 0.02).toFixed(2))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // keyed on the word index alone; ramp-enabled is read fresh from the ref.
  }, [playback.currentWordIndex]);

  // Keyboard Shortcuts (Space play, ←/→ seek, ↑/↓ tempo)
  //
  // This used to depend on `[isPlaying, currentTime, duration, speed]`.
  // `currentTime` used to be pushed from the engine's rAF sync loop up to 60
  // times a second while playing, so the listener was torn down and
  // re-added on nearly every frame (plan 018, Bug 2). It only needs the
  // current values at the moment a key is pressed, so read them from the
  // engine instead of closing over React state, and subscribe exactly once.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (engine.duration > 0) {
          const newTime = Math.max(0, engine.currentTime - 15 * engine.rate);
          handleSeekProgress((newTime / engine.duration) * 100);
        }
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (engine.duration > 0) {
          const newTime = Math.min(engine.duration, engine.currentTime + 15 * engine.rate);
          handleSeekProgress((newTime / engine.duration) * 100);
        }
      } else if (e.code === 'ArrowUp' || (e.shiftKey && (e.key === '+' || e.key === '='))) {
        e.preventDefault();
        handleSpeedChange(Math.min(3.5, Number((engine.rate + 0.25).toFixed(2))));
      } else if (e.code === 'ArrowDown' || (e.shiftKey && (e.key === '-' || e.key === '_'))) {
        e.preventDefault();
        handleSpeedChange(Math.max(0.8, Number((engine.rate - 0.25).toFixed(2))));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
    // subscribes once; everything it reads comes from the engine at call
    // time, not from render-time closures.
  }, []);

  // Dynamic Browser Tab Title
  useEffect(() => {
    if (typeof document !== 'undefined') {
      if (article?.title) {
        document.title = playback.isPlaying
          ? `▶ ${article.title} • Kinreader`
          : `${article.title} • Kinreader`;
      } else {
        document.title = 'Kinreader — Made to Listen';
      }
    }
  }, [article?.title, playback.isPlaying]);

  // Check URL on mount for a failure reported by OAuth redirect
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const urlParams = new URLSearchParams(window.location.search);
    const failure = urlParams.get('auth_error');

    if (failure) {
      window.history.replaceState({}, document.title, window.location.pathname);
      setAuthError(failure);
      setIsAuthOpen(true);
    }
  }, []);

  const remainingSeconds = Math.max(0, playback.duration - playback.currentTime);

  return (
    <div className="flex flex-col justify-between h-[100dvh] max-h-[100dvh] w-full bg-kinreader-radial text-[#ECEAE4] select-none relative overflow-hidden font-sans">
      {/* 1. Header Bar */}
      <Header
        article={article}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenInput={() => setIsInputOpen(true)}
        onOpenLibrary={() => setIsLibraryOpen(true)}
        user={user}
        onOpenAuth={() => setIsAuthOpen(true)}
        speed={playback.rate}
        progress={playback.progress}
        isVoiceEnabled={isVoiceEnabled}
        onToggleVoice={() => setIsVoiceEnabled(!isVoiceEnabled)}
        isRampEnabled={isRampEnabled}
        onToggleRamp={() => setIsRampEnabled(!isRampEnabled)}
      />

      {/* 2. Kinetic Display */}
      <KineticDisplay
        words={playback.words}
        currentWordIndex={playback.currentWordIndex}
        onSelectWord={handleSelectWord}
        viewMode={viewMode}
        fontSize={settings.fontSize || 'md'}
        clauseLength={clauseLength}
      />

      {/* 3. Bottom Controls */}
      <Controls
        isPlaying={playback.isPlaying}
        onTogglePlay={handleTogglePlay}
        speed={playback.rate}
        onSpeedChange={handleSpeedChange}
        progress={playback.progress}
        onSeekProgress={handleSeekProgress}
        currentTime={playback.currentTime}
        duration={playback.duration}
        remainingSeconds={remainingSeconds}
        sourceUrl={article.sourceUrl}
        sourceType={article.sourceType}
        viewMode={viewMode}
        onToggleViewMode={() => setViewMode(viewMode === 'kinetic' ? 'full' : 'kinetic')}
        isSynthesizing={playbackStatus === 'timing' || playbackStatus === 'synthesizing'}
        isDegraded={playbackStatus === 'degraded'}
      />

      {/* Modals, Drawers & Mobile Clipboard Sheet */}
      <ClipboardDetectSheet
        isOpen={!!detectedClipboardUrl}
        detectedUrl={detectedClipboardUrl}
        onClose={() => setDetectedClipboardUrl('')}
        onNarrateNow={handleLoadNewArticle}
        onAddToQueue={(newArt) => {
          saveArticleToLibrary(newArt);
          setSavedArticles(getSavedArticles());
        }}
      />

      <LibraryDrawer
        isOpen={isLibraryOpen}
        onClose={() => setIsLibraryOpen(false)}
        savedArticles={savedArticles}
        currentArticleId={article.sourceUrl || article.title}
        onSelectArticle={handleLoadNewArticle}
        onDeleteArticle={handleDeleteArticle}
        onQuickExtract={(urlToExtract) => {
          extractArticleMutation.mutate(
            { url: urlToExtract },
            {
              onSuccess: (data) => {
                if (data.title) handleLoadNewArticle(data);
              },
              onError: () => {},
            }
          );
        }}
        onOpenSettings={() => setIsSettingsOpen(true)}
        user={user}
        onOpenAuth={() => setIsAuthOpen(true)}
        isPlaying={playback.isPlaying}
        onTogglePlay={handleTogglePlay}
        speed={playback.rate}
      />

      <UrlInputModal
        isOpen={isInputOpen}
        onClose={() => setIsInputOpen(false)}
        onLoadArticle={handleLoadNewArticle}
        onAddToQueue={(newArt) => {
          saveArticleToLibrary(newArt);
          setSavedArticles(getSavedArticles());
        }}
      />

      <AuthModal
        isOpen={isAuthOpen}
        onClose={() => {
          setAuthError(null);
          setIsAuthOpen(false);
        }}
        user={user}
        externalError={authError}
        onDismissExternalError={() => setAuthError(null)}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onSaveSettings={handleSaveSettings}
      />
    </div>
  );
}
