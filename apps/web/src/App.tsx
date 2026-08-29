import React, { useState, useEffect, useRef, useSyncExternalStore, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useQueryState, parseAsString, parseAsStringLiteral } from 'nuqs';
import { Header } from './components/Header';
import { KineticDisplay } from './components/KineticDisplay';
import { Controls } from './components/Controls';
import { UrlInputModal } from './components/UrlInputModal';
import { LibraryDrawer, type SavedArticleItem } from './components/LibraryDrawer';
import { AuthScreen, type UserProfile } from './components/AuthScreen';
import { ClipboardDetectSheet } from './components/ClipboardDetectSheet';
import { SpeechEngine } from './utils/speechEngine';
import {
  openSonioxStream,
  SonioxTemporaryKeyExpiredError,
  type OpenSonioxStreamOptions,
} from './utils/sonioxStream';
import { createWordTimingAccumulator } from './utils/wordTimings';
import {
  uploadAndFinalizeExactTrack,
  type ExactTrackCacheEntry,
  type PersistExactTrackInput,
} from './utils/exactTrackPersistence';
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

const viewParser = parseAsStringLiteral(['reader', 'queue', 'settings', 'auth'] as const).withDefault('reader');

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

export interface AppProps {
  streamingTransport?: (options: OpenSonioxStreamOptions) => { cancel(): void };
  requestTemporaryKey?: (clientId: string) => Promise<{ apiKey: string; expiresAt: string }>;
  loadExactTrack?: (input: { url: string; voice: string }) => Promise<ExactTrackCacheEntry | null>;
  persistExactTrack?: (input: PersistExactTrackInput) => Promise<void>;
}

export function App({
  streamingTransport = openSonioxStream,
  requestTemporaryKey,
  loadExactTrack,
  persistExactTrack,
}: AppProps = {}) {
  const crpc = useCRPC();
  const queryClient = useQueryClient();
  const extractArticleMutation = useMutation(crpc.routers.articles.extract.mutationOptions());
  const temporaryKeyMutation = useMutation(crpc.routers.tts.temporaryKey.mutationOptions());
  const trackUploadUrlMutation = useMutation(crpc.routers.tts.generateTrackUploadUrl.mutationOptions());
  const persistTrackMutation = useMutation(crpc.routers.tts.persistTrack.mutationOptions());
  const saveProgressMutation = useMutation(crpc.routers.users.saveUserProgress.mutationOptions());
  const addToPlaylistMutation = useMutation(crpc.routers.users.addToPlaylist.mutationOptions());
  const deleteUserArticleMutation = useMutation(crpc.routers.users.deleteUserArticle.mutationOptions());

  const lookupExactTrack =
    loadExactTrack ??
    ((input: { url: string; voice: string }) =>
      queryClient.fetchQuery(crpc.routers.tts.getExactTrack.queryOptions(input)));
  const persistCompletedExactTrack =
    persistExactTrack ??
    ((input: PersistExactTrackInput) =>
      uploadAndFinalizeExactTrack(input, {
        requestUploadUrl: (clientId) => trackUploadUrlMutation.mutateAsync({ clientId }),
        finalizeTrack: (finalizeInput) => persistTrackMutation.mutateAsync(finalizeInput),
      }));

  const { data: session } = authClient.useSession();
  const user: UserProfile | null = session?.user
    ? {
        name: session.user.name?.trim() || session.user.email?.split('@')[0] || 'Reader',
        email: session.user.email,
        avatar: session.user.image || undefined,
        tier: 'pro',
      }
    : null;

  const { data: cloudPlaylist } = useQuery(
    crpc.routers.users.getUserPlaylist.queryOptions({}, { enabled: !!user })
  );

  // Type-safe URL query states powered by nuqs
  const [queryUrl, setQueryUrl] = useQueryState('url', parseAsString.withDefault(''));
  const [activeView, setActiveView] = useQueryState('view', viewParser);

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

  // View & Dialog Navigation State (in-page full views)
  const [isInputOpen, setIsInputOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>('idle');
  const [detectedClipboardUrl, setDetectedClipboardUrl] = useState<string>('');

  const saveSettingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Monotonically increasing load identifier to discard stale responses from
  // in-flight synthesis requests if the user switches articles rapidly (plan 019).
  const loadIdRef = useRef(0);
  const activeStreamRef = useRef<{ cancel(): void } | null>(null);

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
    const currentLoadId = ++loadIdRef.current;

    activeStreamRef.current?.cancel();
    activeStreamRef.current = null;
    eng.stop();
    eng.updateMediaSession({ title: art.title, author: art.author || 'Author', image: art.image });

    if (art.title === SAMPLE_ARTICLE.title) {
      try {
        eng.loadAudioUrl('/sample_audio.mp3', SAMPLE_TIMINGS, SAMPLE_DURATION);
        if (loadIdRef.current === currentLoadId) {
          setPlaybackStatus('ready');
        }
      } catch {
        if (loadIdRef.current === currentLoadId) {
          const hasDeviceSpeech = eng.loadBrowserText(art.content, SAMPLE_TIMINGS);
          setPlaybackStatus(hasDeviceSpeech ? 'degraded' : 'error');
        }
      }
      return;
    }

    // 1. Estimated word timings, shown until real ones arrive. The Soniox REST
    // stream carries no alignment data, so this is a guess -- see plan 022 for
    // the WebSocket path that replaces it with measured timestamps.
    const wordsList = art.content.split(/\s+/).filter(Boolean);
    let curTime = 0;
    const initialWordTimings: WordTiming[] = wordsList.map((w) => {
      const start = curTime;
      // These constants claimed ~175 WPM but produced 265 WPM, so the estimate
      // ran ~1.5x fast and the words led the voice from the first sentence.
      // Re-derived by timing the Adrian voice over the WebSocket API: 70 words
      // of prose took 23.72s (177 WPM), against 15.87s predicted. Scaling every
      // term by 1.495 lands the same passage at 23.80s / 176 WPM.
      // Base duration: ~0.063s per char, min 0.21s, max 0.66s.
      let d = Math.max(0.21, Math.min(0.66, w.length * 0.063));
      // Punctuation pauses, scaled by the same factor.
      if (/[,\;:]$/.test(w)) {
        d += 0.075;
      } else if (/[.!?]$/.test(w)) {
        d += 0.24;
      } else if (/[—–]$/.test(w)) {
        d += 0.15;
      }
      const end = start + d;
      curTime = end;
      return { text: w, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
    });

    const totalDuration = Number(curTime.toFixed(3));
    eng.setWordTimings(initialWordTimings, totalDuration);
    setPlaybackStatus('synthesizing');

    const isCurrentLoad = () => loadIdRef.current === currentLoadId;
    const voice = currSettings.sonioxVoice || 'Adrian';
    const cacheUrl = art.sourceUrl || art.title;
    const cancelCurrentStream = () => {
      activeStreamRef.current?.cancel();
      activeStreamRef.current = null;
    };
    const useBrowserFallback = () => {
      if (!isCurrentLoad()) return;
      const hasDeviceSpeech = eng.loadBrowserText(art.content, initialWordTimings);
      setPlaybackStatus(hasDeviceSpeech ? 'degraded' : 'error');
    };
    const useRestFallback = () => {
      if (!isCurrentLoad()) return;
      cancelCurrentStream();
      eng.stop();
      try {
        // REST has no timestamp envelope, so this deliberately keeps the
        // estimated/calibrated timeline. Speed remains client-side only.
        const streamUrl = `/api/tts/stream?text=${encodeURIComponent(art.content)}&voice=${encodeURIComponent(currSettings.sonioxVoice || 'Adrian')}&speed=1.0`;
        eng.loadAudioUrl(streamUrl, initialWordTimings, totalDuration, useBrowserFallback);
        setPlaybackStatus('degraded');
      } catch {
        useBrowserFallback();
      }
    };
    const mergeAuthoritativePrefix = (exactWords: WordTiming[]): WordTiming[] => {
      if (exactWords.length >= initialWordTimings.length) {
        return exactWords.slice(0, initialWordTimings.length);
      }
      const lastExactEnd = exactWords.at(-1)?.end ?? 0;
      const estimatedSuffix = initialWordTimings.slice(exactWords.length);
      const estimatedJoin = estimatedSuffix[0]?.start ?? lastExactEnd;
      const shift = lastExactEnd - estimatedJoin;
      return [
        ...exactWords,
        ...estimatedSuffix.map((word) => ({
          ...word,
          start: Number((word.start + shift).toFixed(3)),
          end: Number((word.end + shift).toFixed(3)),
        })),
      ];
    };

    const runWebSocketAttempt = async (retryCount: number): Promise<void> => {
      try {
        const clientId = getOrCreateClientId();
        const temporaryKey = await (requestTemporaryKey
          ? requestTemporaryKey(clientId)
          : temporaryKeyMutation.mutateAsync({ clientId }));
        if (!isCurrentLoad()) return;

        const accumulator = createWordTimingAccumulator(art.content.trim());
        const exactWords: WordTiming[] = [];
        let audioFinished = false;
        let completedBlob: Blob | null = null;
        let attemptActive = true;
        const progressivePlayback = eng.startStreamingSession(initialWordTimings, totalDuration);
        setPlaybackStatus(progressivePlayback ? 'synthesizing' : 'degraded');

        const finalizeTimings = () => {
          if (!attemptActive || !isCurrentLoad()) return;
          exactWords.push(...accumulator.flush());
          if (exactWords.length !== initialWordTimings.length) {
            attemptActive = false;
            useRestFallback();
            return;
          }
          const exactDuration = exactWords.at(-1)?.end ?? 0;
          eng.appendWordTimings(exactWords, exactDuration, { authoritative: true });
          attemptActive = false;
          activeStreamRef.current = null;
          setPlaybackStatus('ready');

          if (completedBlob) {
            const persistenceInput: PersistExactTrackInput = {
              clientId,
              url: cacheUrl,
              title: art.title,
              author: art.author,
              text: art.content.trim(),
              voice,
              blob: completedBlob,
              duration: exactDuration,
              words: exactWords,
            };
            void Promise.resolve()
              .then(() => persistCompletedExactTrack(persistenceInput))
              .catch((error) => {
                console.warn('Exact track persistence failed; keeping completed playback:', error);
              });
          }
        };

        const stream = streamingTransport({
          apiKey: temporaryKey.apiKey,
          text: art.content.trim(),
          voice,
          handlers: {
            onAudio: (chunk) => {
              if (!attemptActive || !isCurrentLoad()) return;
              eng.appendAudioChunk(chunk);
            },
            onTimestamps: (batch) => {
              if (!attemptActive || !isCurrentLoad()) return;
              exactWords.push(...accumulator.append(batch));
              if (exactWords.length === 0 || exactWords.length > initialWordTimings.length) return;
              const merged = mergeAuthoritativePrefix(exactWords);
              eng.appendWordTimings(merged, merged.at(-1)?.end ?? totalDuration, { authoritative: true });
            },
            onDone: () => {
              if (!attemptActive || !isCurrentLoad()) return;
              audioFinished = true;
              completedBlob = eng.finishStreamingSession();
            },
            onTerminated: () => {
              if (!attemptActive || !isCurrentLoad()) return;
              if (!audioFinished) completedBlob = eng.finishStreamingSession();
              finalizeTimings();
            },
            onError: (error) => {
              if (!attemptActive || !isCurrentLoad()) return;
              attemptActive = false;
              cancelCurrentStream();
              if (error instanceof SonioxTemporaryKeyExpiredError && retryCount === 0) {
                eng.stop();
                void runWebSocketAttempt(1);
                return;
              }
              useRestFallback();
            },
          },
        });
        if (attemptActive && isCurrentLoad() && eng.isStreaming) {
          activeStreamRef.current = stream;
        } else {
          stream.cancel();
        }
      } catch {
        useRestFallback();
      }
    };

    try {
      const cachedTrack = await lookupExactTrack({ url: cacheUrl, voice });
      if (!isCurrentLoad()) return;
      if (cachedTrack) {
        let cacheFailed = false;
        eng.loadAudioUrl(cachedTrack.audioUrl, cachedTrack.words, cachedTrack.duration, () => {
          if (cacheFailed || !isCurrentLoad()) return;
          cacheFailed = true;
          void runWebSocketAttempt(0);
        });
        setPlaybackStatus('ready');
        return;
      }
    } catch (error) {
      console.warn('Exact track cache lookup failed; continuing with synthesis:', error);
    }

    void runWebSocketAttempt(0);
  };

  const effectiveSavedArticles: SavedArticleItem[] = useMemo(() => {
    if (user && cloudPlaylist && cloudPlaylist.length > 0) {
      return cloudPlaylist.map((cp: any) => ({
        id: cp.article.url || cp.articleId,
        article: {
          title: cp.article.title,
          author: cp.article.author,
          authorHandle: cp.article.authorHandle,
          authorAvatar: cp.article.authorAvatar,
          content: cp.article.content,
          image: cp.article.image,
          sourceUrl: cp.article.url,
          sourceType: cp.article.sourceType,
        },
        progress: cp.progress || 0,
        lastReadAt: cp.updatedAt || cp.article.createdAt,
      }));
    }
    return savedArticles;
  }, [user, cloudPlaylist, savedArticles]);

  const handleLoadNewArticle = (newArticle: ArticleData) => {
    setArticle(newArticle);
    saveArticleToLibrary(newArticle);
    setSavedArticles(getSavedArticles());

    if (newArticle.sourceUrl && newArticle.sourceUrl !== SAMPLE_ARTICLE.sourceUrl) {
      setQueryUrl(newArticle.sourceUrl, { history: 'push' });
    } else {
      setQueryUrl(null, { history: 'replace' });
    }

    if (user) {
      addToPlaylistMutation.mutate({
        url: newArticle.sourceUrl || newArticle.title,
        title: newArticle.title,
        content: newArticle.content,
        author: newArticle.author,
        authorHandle: newArticle.authorHandle,
        authorAvatar: newArticle.authorAvatar,
        image: newArticle.image,
        sourceType: newArticle.sourceType,
      });
    }
    loadArticleContent(newArticle, engine, settings);
  };

  const handleViewChange = (newView: 'reader' | 'queue' | 'settings' | 'auth') => {
    setActiveView(newView === 'reader' ? null : newView, {
      history: newView === 'reader' ? 'replace' : 'push',
    });
  };

  const handleAddToQueue = (newArt: ArticleData) => {
    saveArticleToLibrary(newArt);
    setSavedArticles(getSavedArticles());
    if (user) {
      addToPlaylistMutation.mutate({
        url: newArt.sourceUrl || newArt.title,
        title: newArt.title,
        content: newArt.content,
        author: newArt.author,
        authorHandle: newArt.authorHandle,
        authorAvatar: newArt.authorAvatar,
        image: newArt.image,
        sourceType: newArt.sourceType,
      });
    }
  };

  const handleDeleteArticle = (id: string) => {
    deleteArticleFromLibrary(id);
    const updated = getSavedArticles();
    setSavedArticles(updated);
    if (user) {
      deleteUserArticleMutation.mutate({ articleId: id });
    }

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
    if (newSettings.defaultRate && Math.abs(newSettings.defaultRate - playback.rate) > 0.05) {
      handleSpeedChange(newSettings.defaultRate);
    }
    if (saveSettingsTimerRef.current) {
      clearTimeout(saveSettingsTimerRef.current);
    }
    saveSettingsTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem('kinetic_reader_settings', JSON.stringify(newSettings));
      } catch (err) {
        console.warn('Failed to save settings:', err);
      }
    }, 250);
  };

  // 1. Synchronize active article with URL query state via nuqs & initial search params
  useEffect(() => {
    const targetUrl =
      queryUrl ||
      (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('url') : null);
    if (!targetUrl || !targetUrl.trim()) return;
    const decodedUrl = targetUrl.trim();
    if (article.sourceUrl === decodedUrl) return;

    const localSaved = getSavedArticles();
    const foundLocal = localSaved.find(
      (item) => item.article.sourceUrl === decodedUrl || item.id === decodedUrl
    );

    if (foundLocal) {
      setArticle(foundLocal.article);
      loadArticleContent(foundLocal.article, engine, settings);
      return;
    }

    extractArticleMutation
      .mutateAsync({ url: decodedUrl })
      .then((data) => {
        if (data.title && data.content) {
          setArticle(data);
          saveArticleToLibrary(data);
          setSavedArticles(getSavedArticles());
          loadArticleContent(data, engine, settings);
        }
      })
      .catch((err) => {
        console.warn('Failed to extract article from URL query:', err);
      });
  }, [queryUrl]);

  // 2. Initial sample audio load on mount (only if no custom ?url= query is present)
  useEffect(() => {
    const savedSettings = settings;
    if (savedSettings.defaultRate) {
      handleSpeedChange(savedSettings.defaultRate);
    }

    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    if (!urlParams?.get('url')) {
      loadArticleContent(SAMPLE_ARTICLE, engine, savedSettings);
    }

    return () => {
      loadIdRef.current += 1;
      activeStreamRef.current?.cancel();
      activeStreamRef.current = null;
      engine.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // Sync reading progress to user's database record (debounced per clause change)
  useEffect(() => {
    if (!user || !article || playback.words.length === 0) return;

    const timer = setTimeout(() => {
      const artId = article.sourceUrl || article.title;
      saveProgressMutation.mutate({
        articleId: artId,
        progress: Number(playback.progress.toFixed(1)),
        lastWordIndex: playback.currentWordIndex,
        currentTime: Number(playback.currentTime.toFixed(2)),
        isCompleted: playback.progress >= 98,
      });
    }, 2000);

    return () => clearTimeout(timer);
  }, [playback.currentWordIndex, user]);

  // Tempo Acceleration Ramp Effect (smooth +0.02× increase per clause transition)
  useEffect(() => {
    if (!playback.isPlaying || !isRampEnabledRef.current) return;
    if (playback.currentWordIndex > 0 && playback.currentWordIndex % 6 === 0) {
      const targetRate = Math.min(3.5, Number((engine.rate + 0.02).toFixed(2)));
      handleSpeedChange(targetRate);
    }
  }, [playback.currentWordIndex, playback.isPlaying]);

  // Keyboard Shortcuts: Space for Play/Pause, Esc for Close, Up/Down for Speed
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement as HTMLElement)?.tagName;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'Escape') {
        handleViewChange('reader');
        setIsInputOpen(false);
      } else if (e.code === 'ArrowUp' || (e.shiftKey && (e.key === '=' || e.key === '+'))) {
        e.preventDefault();
        handleSpeedChange(Math.min(3.5, Number((engine.rate + 0.25).toFixed(2))));
      } else if (e.code === 'ArrowDown' || (e.shiftKey && (e.key === '-' || e.key === '_'))) {
        e.preventDefault();
        handleSpeedChange(Math.max(0.8, Number((engine.rate - 0.25).toFixed(2))));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Global Paste Listener for instant clipboard detection (plan 019)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePaste = (e: ClipboardEvent) => {
      const targetTag = (e.target as HTMLElement)?.tagName;
      if (targetTag === 'INPUT' || targetTag === 'TEXTAREA') return;

      const pastedText = e.clipboardData?.getData('text')?.trim();
      if (pastedText && (pastedText.startsWith('http://') || pastedText.startsWith('https://'))) {
        e.preventDefault();
        setDetectedClipboardUrl(pastedText);
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
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

  // Check URL on mount for a failure reported by an auth redirect.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const urlParams = new URLSearchParams(window.location.search);
    const betterAuthError = urlParams.get('error');
    const failure =
      urlParams.get('auth_error') ??
      urlParams.get('error_description') ??
      (betterAuthError === 'INVALID_TOKEN'
        ? 'This sign-in link is invalid or has expired. Request a new link and try again.'
        : betterAuthError
          ? 'Sign-in failed. Request a new link and try again.'
          : null);

    if (failure) {
      window.history.replaceState({}, document.title, window.location.pathname);
      setAuthError(failure);
    }
  }, []);

  const remainingSeconds = Math.max(0, playback.duration - playback.currentTime);

  return (
    <div className="w-full h-[100dvh] max-h-[100dvh] bg-[#0B0C10] text-[#ECEAE4] select-none relative overflow-hidden font-sans">
      {activeView === 'auth' || authError ? (
        <AuthScreen
          onBack={() => {
            setAuthError(null);
            handleViewChange('reader');
          }}
          user={user}
          externalError={authError}
          onDismissExternalError={() => setAuthError(null)}
          onLoginSuccess={() => {
            setAuthError(null);
            handleViewChange('reader');
          }}
        />
      ) : activeView !== 'reader' ? (
        <LibraryDrawer
          isOpen={true}
          onClose={() => handleViewChange('reader')}
          savedArticles={effectiveSavedArticles}
          currentArticleId={article.sourceUrl || article.title}
          onSelectArticle={(newArt) => {
            handleLoadNewArticle(newArt);
            handleViewChange('reader');
          }}
          onDeleteArticle={handleDeleteArticle}
          onQuickExtract={(urlToExtract) => {
            extractArticleMutation.mutate(
              { url: urlToExtract },
              {
                onSuccess: (data) => {
                  if (data.title) {
                    handleLoadNewArticle(data);
                    handleViewChange('reader');
                  }
                },
                onError: () => {},
              }
            );
          }}
          user={user}
          onOpenAuth={() => handleViewChange('auth')}
          isPlaying={playback.isPlaying}
          onTogglePlay={handleTogglePlay}
          speed={playback.rate}
          settings={settings}
          onSaveSettings={handleSaveSettings}
          initialTab={activeView === 'settings' ? 'settings' : 'queue'}
        />
      ) : (
        <div className="w-full h-full flex flex-col justify-between bg-kinreader-radial">
          {/* 1. Header Bar */}
          <Header
            article={article}
            onOpenSettings={() => handleViewChange('settings')}
            onOpenInput={() => setIsInputOpen(true)}
            onOpenLibrary={() => handleViewChange('queue')}
            user={user}
            onOpenAuth={() => handleViewChange('auth')}
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
            isError={playbackStatus === 'error'}
          />
        </div>
      )}

      {/* Modals & Bottom Sheets */}
      <ClipboardDetectSheet
        isOpen={!!detectedClipboardUrl}
        detectedUrl={detectedClipboardUrl}
        onClose={() => setDetectedClipboardUrl('')}
        onNarrateNow={(newArt) => {
          handleLoadNewArticle(newArt);
          handleViewChange('reader');
        }}
        onAddToQueue={handleAddToQueue}
      />

      <UrlInputModal
        isOpen={isInputOpen}
        onClose={() => setIsInputOpen(false)}
        onLoadArticle={(newArt) => {
          handleLoadNewArticle(newArt);
          handleViewChange('reader');
        }}
        onAddToQueue={handleAddToQueue}
      />
    </div>
  );
}
