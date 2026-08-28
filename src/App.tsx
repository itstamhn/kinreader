import React, { useState, useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Header } from './components/Header';
import { KineticDisplay } from './components/KineticDisplay';
import { Controls } from './components/Controls';
import { UrlInputModal } from './components/UrlInputModal';
import { SettingsModal } from './components/SettingsModal';
import { LibraryDrawer, type SavedArticleItem } from './components/LibraryDrawer';
import { AuthModal, type UserProfile } from './components/AuthModal';
import { ShareClipModal } from './components/ShareClipModal';
import { ClipboardDetectSheet } from './components/ClipboardDetectSheet';
import { SpeechEngine } from './utils/speechEngine';
import { SAMPLE_ARTICLE, SAMPLE_TIMINGS, SAMPLE_DURATION } from './data/sampleData';
import {
  getSavedArticles,
  saveArticleToLibrary,
  deleteArticleFromLibrary,
  getCachedArticleAudio,
  cacheArticleAudio,
} from './lib/storage';
import { useCRPC } from './lib/convex';
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

export function App() {
  const crpc = useCRPC();
  const extractArticleMutation = useMutation(crpc.routers.articles.extract.mutationOptions());

  const [user, setUser] = useState<UserProfile | null>(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem('kinreader_user');
        return raw ? JSON.parse(raw) : null;
      } catch {}
    }
    return null;
  });

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

  // Kinetic Words & Playback State
  const [words, setWords] = useState<WordTiming[]>(SAMPLE_TIMINGS);
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(settings.defaultRate || 1.5);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(SAMPLE_DURATION);
  const [viewMode, setViewMode] = useState<'kinetic' | 'full'>('kinetic');

  // Modals & Bottom Sheets State
  const [isInputOpen, setIsInputOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isClipOpen, setIsClipOpen] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [detectedClipboardUrl, setDetectedClipboardUrl] = useState<string>('');

  const engineRef = useRef<SpeechEngine | null>(null);

  // Initialize Speech Engine on mount
  useEffect(() => {
    const engine = new SpeechEngine();
    engine.rate = speed;
    engine.setCallbacks(
      (wordIdx) => {
        setCurrentWordIndex(wordIdx);
        // Automatic ramp handling if enabled
        if (isRampEnabled && wordIdx > 0 && wordIdx % 12 === 0) {
          setSpeed((prev) => {
            const nextSpeed = Math.min(3.5, Number((prev + 0.02).toFixed(2)));
            engine.rate = nextSpeed;
            return nextSpeed;
          });
        }
      },
      (prog, curT, dur) => {
        setProgress(prog);
        setCurrentTime(curT);
        setDuration(dur);
      },
      (playing) => setIsPlaying(playing)
    );
    engineRef.current = engine;

    // Pre-load Soniox sample audio asset
    engine.loadAudioUrl('/sample_audio.mp3', SAMPLE_TIMINGS, SAMPLE_DURATION);

    return () => {
      engine.stop();
    };
  }, [isRampEnabled]);

  // Load article audio with Soniox v2
  const loadArticleContent = async (
    art: ArticleData,
    engine: SpeechEngine,
    currSettings: ReaderSettings
  ) => {
    engine.stop();
    setCurrentWordIndex(0);
    setProgress(0);
    engine.updateMediaSession({ title: art.title, author: art.author || 'Author', image: art.image });

    const articleKey = art.sourceUrl || art.title;

    if (art.title === SAMPLE_ARTICLE.title) {
      setWords(SAMPLE_TIMINGS);
      setDuration(SAMPLE_DURATION);
      engine.loadAudioUrl('/sample_audio.mp3', SAMPLE_TIMINGS, SAMPLE_DURATION);
      setIsLoadingAudio(false);
      return;
    }

    const cached = getCachedArticleAudio(articleKey, currSettings.sonioxVoice || 'Adrian', 1.0);
    if (cached && cached.audioBase64 && cached.words?.length > 0) {
      setWords(cached.words);
      setDuration(cached.duration);
      engine.loadAudio(cached.audioBase64, cached.words, cached.duration);
      setIsLoadingAudio(false);
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

    setWords(initialWordTimings);
    setDuration(Number(curTime.toFixed(3)));
    setIsLoadingAudio(true);

    // 2. Fetch Soniox Studio Neural Voice v2
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(9000),
        body: JSON.stringify({
          provider: 'soniox',
          text: art.content,
          sonioxApiKey: currSettings.sonioxApiKey || undefined,
          sonioxVoice: currSettings.sonioxVoice || 'Adrian',
          speed: 1.0,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.audioBase64 && data.words && data.words.length > 0) {
          setWords(data.words);
          setDuration(data.duration || curTime);
          engine.loadAudio(data.audioBase64, data.words, data.duration || curTime);
          cacheArticleAudio(
            articleKey,
            data.audioBase64,
            data.words,
            data.duration || curTime,
            currSettings.sonioxVoice || 'Adrian',
            1.0
          );
          setIsLoadingAudio(false);
          return;
        }
      }
    } catch (err) {
      console.warn('Soniox neural synthesis fallback:', err);
    }

    // 3. Fallback to device speech only if offline or synthesis fails
    engine.loadBrowserText(art.content, initialWordTimings);
    setIsLoadingAudio(false);
  };

  const handleTogglePlay = () => {
    if (!engineRef.current) return;
    if (isPlaying) {
      engineRef.current.pause();
    } else {
      engineRef.current.play();
    }
  };

  const handleSpeedChange = (newSpeed: number) => {
    const clamped = Math.max(0.8, Math.min(3.5, Number(newSpeed.toFixed(2))));
    setSpeed(clamped);
    if (engineRef.current) {
      engineRef.current.rate = clamped;
    }
  };

  const handleSeekProgress = (percent: number) => {
    if (engineRef.current) {
      engineRef.current.seekToProgress(percent);
    }
  };

  const handleSelectWord = (wordIndex: number) => {
    if (engineRef.current) {
      engineRef.current.seekToWordIndex(wordIndex);
    }
  };

  const handleLoadNewArticle = (newArticle: ArticleData) => {
    setArticle(newArticle);
    saveArticleToLibrary(newArticle);
    setSavedArticles(getSavedArticles());

    if (engineRef.current) {
      loadArticleContent(newArticle, engineRef.current, settings);
    }
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
    if (newSettings.defaultRate && Math.abs(newSettings.defaultRate - speed) > 0.05) {
      handleSpeedChange(newSettings.defaultRate);
    }
  };

  // Keyboard Shortcuts (Space play, ←/→ clauses, ↑/↓ tempo)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (duration > 0) {
          const newTime = Math.max(0, currentTime - 15 * speed);
          handleSeekProgress((newTime / duration) * 100);
        }
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (duration > 0) {
          const newTime = Math.min(duration, currentTime + 15 * speed);
          handleSeekProgress((newTime / duration) * 100);
        }
      } else if (e.code === 'ArrowUp' || (e.shiftKey && (e.key === '+' || e.key === '='))) {
        e.preventDefault();
        handleSpeedChange(Math.min(3.5, Number((speed + 0.25).toFixed(2))));
      } else if (e.code === 'ArrowDown' || (e.shiftKey && (e.key === '-' || e.key === '_'))) {
        e.preventDefault();
        handleSpeedChange(Math.max(0.8, Number((speed - 0.25).toFixed(2))));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, currentTime, duration, speed]);

  // Dynamic Browser Tab Title
  useEffect(() => {
    if (typeof document !== 'undefined') {
      if (article?.title) {
        document.title = isPlaying
          ? `▶ ${article.title} • Kinreader`
          : `${article.title} • Kinreader`;
      } else {
        document.title = 'Kinreader — Made to Listen';
      }
    }
  }, [article?.title, isPlaying]);

  // Check URL on mount for auth token
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('auth_token');
    const email = urlParams.get('email');
    if (!token || !email) return;

    // Strip the credentials from the address bar before any await.
    window.history.replaceState({}, document.title, window.location.pathname);

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, token }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data?.success || !data.user) return;
        setUser(data.user);
        localStorage.setItem('kinreader_user', JSON.stringify(data.user));
      } catch {
        // Verification failed — stay signed out.
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const handleLoginSuccess = (newUser: UserProfile) => {
    setUser(newUser);
    localStorage.setItem('kinreader_user', JSON.stringify(newUser));
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('kinreader_user');
  };

  const remainingSeconds = Math.max(0, duration - currentTime);

  return (
    <div className="flex flex-col justify-between h-[100dvh] max-h-[100dvh] w-full bg-kinreader-radial text-[#ECEAE4] select-none relative overflow-hidden font-sans">
      {/* 1. Header Bar (Design 3a & 1a) */}
      <Header
        article={article}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenInput={() => setIsInputOpen(true)}
        onOpenLibrary={() => setIsLibraryOpen(true)}
        onOpenClip={() => setIsClipOpen(true)}
        user={user}
        onOpenAuth={() => setIsAuthOpen(true)}
        speed={speed}
        isVoiceEnabled={isVoiceEnabled}
        onToggleVoice={() => setIsVoiceEnabled(!isVoiceEnabled)}
        isRampEnabled={isRampEnabled}
        onToggleRamp={() => setIsRampEnabled(!isRampEnabled)}
        clauseLength={clauseLength}
        onChangeClauseLength={(len) => setClauseLength(len)}
      />

      {/* 2. Top Progress Line */}
      <div className="w-full px-4 sm:px-6">
        <div className="h-[2px] w-full rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#B87718] to-[#F2A33C] shadow-[0_0_8px_rgba(242,163,60,0.5)] transition-all duration-75"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* 3. Kinetic Display (Design 3a mobile scale & desktop) */}
      <KineticDisplay
        words={words}
        currentWordIndex={currentWordIndex}
        onSelectWord={handleSelectWord}
        viewMode={viewMode}
        fontSize={settings.fontSize || 'md'}
        clauseLength={clauseLength}
      />

      {/* 4. Bottom Controls (Design 3a mobile thumb zone & desktop bar) */}
      <Controls
        isPlaying={isPlaying}
        onTogglePlay={handleTogglePlay}
        speed={speed}
        onSpeedChange={handleSpeedChange}
        progress={progress}
        onSeekProgress={handleSeekProgress}
        currentTime={currentTime}
        duration={duration}
        remainingSeconds={remainingSeconds}
        sourceUrl={article.sourceUrl}
        sourceType={article.sourceType}
        viewMode={viewMode}
        onToggleViewMode={() => setViewMode(viewMode === 'kinetic' ? 'full' : 'kinetic')}
        isLoadingAudio={isLoadingAudio}
      />

      {/* Modals, Drawers, Clip Maker & Mobile Clipboard Sheet */}
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

      <ShareClipModal
        isOpen={isClipOpen}
        onClose={() => setIsClipOpen(false)}
        article={article}
        currentWord={words[currentWordIndex]?.text}
        speed={speed}
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
        isPlaying={isPlaying}
        onTogglePlay={handleTogglePlay}
        speed={speed}
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
        onClose={() => setIsAuthOpen(false)}
        onLoginSuccess={handleLoginSuccess}
        user={user}
        onLogout={handleLogout}
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
