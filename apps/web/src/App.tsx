import React, { useState, useEffect, useRef, useSyncExternalStore, useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useQueryState, parseAsString, parseAsStringLiteral } from 'nuqs';
import { ReaderFrame } from './components/ReaderFrame';
import { Header } from './components/Header';
import { KineticDisplay } from './components/KineticDisplay';
import { Controls } from './components/Controls';
import { UrlInputModal } from './components/UrlInputModal';
import { LibraryDrawer, type SavedArticleItem } from './components/LibraryDrawer';
import { AuthScreen, type UserProfile } from './components/AuthScreen';
import { ClipboardDetectSheet } from './components/ClipboardDetectSheet';
import { SpeechEngine } from './utils/speechEngine';
import { SonioxTemporaryKeyExpiredError, type OpenSonioxStreamOptions } from './utils/sonioxStream';
import { createWordTimingAccumulator } from './utils/wordTimings';
import { openParallelSonioxStream } from './utils/parallelSoniox';
import { playDurableNarration } from './utils/durableNarration';
import { DURABLE_NARRATION_MAX_CHARS, DURABLE_NARRATION_MAX_WORDS, type NarrationPage } from '@kinreader/backend/tts/durableNarration';
import { narrationText, MAX_PREGENERATION_CHARS } from '@kinreader/backend/tts/limits';
import { articleCacheKey, articleContentDigest } from './utils/articleCacheKey';
import { decodeShareId } from './utils/shareLink';
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
  updateArticleProgress,
  resumeWordIndexFor,
  articleLibraryId,
  RESUME_MIN_WORD_INDEX,
} from './lib/storage';
import { useCRPC, useCRPCClient } from './lib/convex';
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
  readerTheme: 'dark',
};

// Playback always uses Soniox audio. A failure remains an explicit error;
// degraded playback means estimated word timings, never a different voice.
type PlaybackStatus =
  | 'idle' // sample article, nothing loaded
  | 'timing' // instant word timings computed, audio not yet requested
  | 'synthesizing' // waiting on the Convex TTS action
  | 'ready' // neural audio loaded
  | 'degraded' // Soniox audio with estimated word timings
  | 'error'; // nothing playable

// Above this the article no longer fits in a GET query string (Cloudflare caps
// URLs at 16KB and the text is percent-encoded), so the REST fallback POSTs
// the text and plays the returned Blob instead.
const REST_GET_MAX_CHARS = 6000;

// How often reading position is written: every few seconds while audio is
// playing, and shortly after the position settles when paused (so a timeline
// drag or a run of arrow-key seeks is one write, not one per word).
const PROGRESS_SAVE_INTERVAL_MS = { playing: 5000, paused: 1000 } as const;

// When exact timings stop partway through a live stream, the words after the
// last exact one keep their estimated spacing but are fitted onto the audio
// that actually arrived, so the highlight ends when the voice does.
export function fitEstimatedTail(words: WordTiming[], exactCount: number, audioSeconds: number): WordTiming[] {
  if (exactCount >= words.length || exactCount < 0) return words;
  const joinAt = exactCount > 0 ? words[exactCount - 1]!.end : 0;
  const tail = words.slice(exactCount);
  const tailStart = tail[0]!.start;
  const tailEnd = tail.at(-1)!.end;
  if (!(audioSeconds > joinAt) || !(tailEnd > tailStart)) return words;
  const scale = (audioSeconds - joinAt) / (tailEnd - tailStart);
  // A wild ratio means the estimate and the audio are not the same text.
  if (scale < 0.3 || scale > 4) return words;
  return [
    ...words.slice(0, exactCount),
    ...tail.map((word) => ({
      ...word,
      start: Number((joinAt + (word.start - tailStart) * scale).toFixed(3)),
      end: Number((joinAt + (word.end - tailStart) * scale).toFixed(3)),
    })),
  ];
}

const ESTIMATED_TIMING_MESSAGE = 'Exact word sync unavailable. Using estimated timing for this article.';
const SONIOX_UNAVAILABLE_MESSAGE = 'Soniox audio is unavailable. Retry audio to try again.';

export interface AppProps {
  durableNarration?: boolean;
  narrationPage?: (input: { contentDigest: string; voice: string; from: number }) => Promise<NarrationPage>;
  streamingTransport?: (options: OpenSonioxStreamOptions) => { cancel(): void };
  requestTemporaryKey?: (clientId: string) => Promise<{ apiKey: string; expiresAt: string }>;
  loadExactTrack?: (input: { url: string; voice: string }) => Promise<ExactTrackCacheEntry | null>;
  persistExactTrack?: (input: PersistExactTrackInput) => Promise<void>;
  /** Disables both server cache reads and persistence (tests). */
  serverExactCacheEnabled?: boolean;
  /** Asks the server to synthesise an article into the global cache ahead of play. */
  requestPregeneration?: (input: PregenerationRequest) => Promise<unknown>;
  /** State of the server-side job for an article, so an in-flight one is awaited rather than duplicated. */
  pregenerationStatus?: (input: { contentDigest: string; voice: string }) => Promise<PregenerationJobStatus>;
  /** Interval between job-status polls while waiting (tests shorten it). */
  pregenerationPollMs?: number;
}

export type PregenerationJobStatus = {
  status: 'none' | 'running' | 'done' | 'failed';
  startedAt: number | null;
};

export interface PregenerationRequest {
  title?: string;
  author?: string;
  text: string;
  voice: string;
  clientId: string;
}

// How long the reader waits on a running pre-generation before streaming
// after all. Give a nearly finished job a brief chance to reach the cache.
// Older jobs may have been killed by the runtime.
const MAX_PREGENERATION_WAIT_MS = 5000;
const PREGENERATION_STALE_MS = 11 * 60 * 1000;
const DEFAULT_PREGENERATION_POLL_MS = 1500;

// No lookup on the way to playback may hang the reader: a cache read, a job
// status or a key request that does not answer in time is treated as a miss
// and the next step runs. The spinner must always resolve to something.
const LOOKUP_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function App({
  durableNarration = true,
  narrationPage,
  // Several concurrent Soniox sessions re-serialised into one stream, so audio
  // arrives faster than it is played back (see utils/parallelSoniox.ts).
  streamingTransport = openParallelSonioxStream,
  requestTemporaryKey,
  loadExactTrack,
  persistExactTrack,
  serverExactCacheEnabled,
  requestPregeneration,
  pregenerationStatus,
  pregenerationPollMs = DEFAULT_PREGENERATION_POLL_MS,
}: AppProps = {}) {
  const crpc = useCRPC();
  const crpcClient = useCRPCClient();
  const extractArticleMutation = useMutation(crpc.routers.articles.extract.mutationOptions());
  const temporaryKeyMutation = useMutation(crpc.routers.tts.temporaryKey.mutationOptions());
  const trackUploadUrlMutation = useMutation(crpc.routers.tts.generateTrackUploadUrl.mutationOptions());
  const persistTrackMutation = useMutation(crpc.routers.tts.persistTrack.mutationOptions());
  const pregenerateMutation = useMutation(crpc.routers.tts.pregenerate.mutationOptions());
  const prepareNarrationMutation = useMutation(crpc.routers.narration.prepare.mutationOptions());
  const getNarrationText = (content: string) => narrationText(content, durableNarration ? { maxChars: DURABLE_NARRATION_MAX_CHARS, maxWords: DURABLE_NARRATION_MAX_WORDS } : undefined);
  const saveProgressMutation = useMutation(crpc.routers.users.saveUserProgress.mutationOptions());
  const addToPlaylistMutation = useMutation(crpc.routers.users.addToPlaylist.mutationOptions());
  const deleteUserArticleMutation = useMutation(crpc.routers.users.deleteUserArticle.mutationOptions());

  const lookupPregenerationStatus =
    pregenerationStatus ??
    ((input: { contentDigest: string; voice: string }) =>
      // Imperative calls do not invoke React hooks or reuse stale job status.
      crpcClient.routers.tts.pregenerationStatus.query(input));
  const lookupExactTrack =
    loadExactTrack ??
    ((input: { url: string; voice: string }) =>
      crpcClient.routers.tts.getExactTrack.query(input));
  const persistCompletedExactTrack =
    persistExactTrack ??
    ((input: PersistExactTrackInput) =>
      uploadAndFinalizeExactTrack(input, {
        requestUploadUrl: (request) => trackUploadUrlMutation.mutateAsync(request),
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
  // The global cache (server-generated tracks) is readable by everyone; only
  // signed-in listeners can persist their own streamed tracks.
  const canReadServerExactCache = serverExactCacheEnabled ?? true;
  const canPersistExactTrack = serverExactCacheEnabled ?? Boolean(user);

  // Fire-and-forget: synthesise into the global cache so the next open of this
  // article (by anyone) is an instant cached track instead of a live stream.
  const pregenerateArticle = (target: ArticleData) => {
    const text = getNarrationText(target.content).text;
    if (!text || (!durableNarration && text.length > MAX_PREGENERATION_CHARS) || target.title === SAMPLE_ARTICLE.title) return;
    const request: PregenerationRequest = {
      title: target.title,
      author: target.author,
      text,
      voice: settings.sonioxVoice || 'Adrian',
      clientId: getOrCreateClientId(),
    };
    void Promise.resolve()
      .then(() => (requestPregeneration ? requestPregeneration(request) : durableNarration ? prepareNarrationMutation.mutateAsync(request) : pregenerateMutation.mutateAsync(request)))
      .catch((error) => {
        console.warn('Audio preparation request failed:', error);
      });
  };

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

  const isVoiceEnabled = settings.voiceEnabled !== false;
  const isRampEnabled = settings.rampEnabled === true;
  const [readerPage, setReaderPage] = useState({ number: 0, count: 0 });

  const [viewMode, setViewMode] = useState<'kinetic' | 'full'>('kinetic');

  // View & Dialog Navigation State (in-page full views)
  const [isInputOpen, setIsInputOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>('idle');
  const [detectedClipboardUrl, setDetectedClipboardUrl] = useState<string>('');
  // A remote article being fetched for a deep link / quick paste, and the last
  // load that failed. Both used to be invisible: the sample article sat on
  // screen while extraction ran, and a failure only reached the console.
  const [pendingLoadUrl, setPendingLoadUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [awaitingPregeneration, setAwaitingPregeneration] = useState(false);
  const [preparationProgress, setPreparationProgress] = useState<string | null>(null);
  // Why the last fallback happened, so the degraded banner can say it instead
  // of leaving the listener to guess (a Soniox rejection, a 413, a dropped
  // socket...). Cleared on every new load.
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [truncationNotice, setTruncationNotice] = useState<string | null>(null);

  const saveSettingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Monotonically increasing load identifier to discard stale responses from
  // in-flight synthesis requests if the user switches articles rapidly (plan 019).
  const loadIdRef = useRef(0);
  const activeStreamRef = useRef<{ cancel(): void } | null>(null);
  // Object URL of a REST-fallback Blob, revoked on the next load / unmount.
  const restObjectUrlRef = useRef<string | null>(null);
  // Set by the "Play now" button on the waiting banner: stop waiting for the
  // server job and stream (accepting a second synthesis for this article).
  const skipPregenerationWaitRef = useRef(false);
  const lastProgressSaveRef = useRef(0);

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
    if (!engine.playbackReady || (!engine.isPlaying && !engine.getSnapshot().canStartPlayback)) return;
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

  const revokeRestObjectUrl = () => {
    if (restObjectUrlRef.current) {
      try {
        URL.revokeObjectURL(restObjectUrlRef.current);
      } catch {}
      restObjectUrlRef.current = null;
    }
  };

  // Load article audio with Soniox v2
  const loadArticleContent = async (
    art: ArticleData,
    eng: SpeechEngine,
    currSettings: ReaderSettings,
    options: { resumeWordIndex?: number } = {}
  ) => {
    const currentLoadId = ++loadIdRef.current;

    activeStreamRef.current?.cancel();
    activeStreamRef.current = null;
    revokeRestObjectUrl();
    eng.stop();
    eng.updateMediaSession({ title: art.title, author: art.author || 'Author', image: art.image });
    setLoadError(null);
    setAwaitingPregeneration(false);
    setFallbackReason(null);
    setTruncationNotice(null);
    setPreparationProgress(null);
    skipPregenerationWaitRef.current = false;

    const isCurrentLoad = () => loadIdRef.current === currentLoadId;

    // Where to pick the article back up. Applied once, as soon as a word
    // list that covers the index is playable -- for a cached exact track
    // immediately, for a live stream when the real timings reach it, for
    // the fallbacks against their estimated timeline.
    let pendingResumeIndex = Math.max(0, Math.floor(options.resumeWordIndex ?? 0));
    const applyResume = (words: WordTiming[]) => {
      if (pendingResumeIndex <= 0 || !isCurrentLoad()) return;
      if (words.length <= pendingResumeIndex) return;
      const target = pendingResumeIndex;
      pendingResumeIndex = 0;
      eng.seekToWordIndex(target);
    };

    const reportAudioFailure = (reason?: string) => {
      if (!isCurrentLoad()) return;
      activeStreamRef.current?.cancel();
      activeStreamRef.current = null;
      // Preserve completed audio and the reading position. Never change voices.
      eng.pause();
      setPlaybackStatus('error');
      setAwaitingPregeneration(false);
      setPreparationProgress(reason ? `${SONIOX_UNAVAILABLE_MESSAGE} ${reason}` : SONIOX_UNAVAILABLE_MESSAGE);
    };

    if (art.title === SAMPLE_ARTICLE.title) {
      try {
        eng.loadAudioUrl('/sample_audio.mp3', SAMPLE_TIMINGS, SAMPLE_DURATION, () => reportAudioFailure('The sample recording could not be loaded.'));
        if (loadIdRef.current === currentLoadId) {
          applyResume(SAMPLE_TIMINGS);
          setPlaybackStatus('ready');
        }
      } catch {
        if (loadIdRef.current === currentLoadId) {
          reportAudioFailure('The sample recording could not be loaded.');
        }
      }
      return;
    }

    // 0. What gets narrated. Very long pieces are cut to a sentence-aligned
    // prefix the cache and a Soniox session can hold (shared/tts/limits.ts);
    // the displayed words, the stream, the cache key and pre-generation all
    // use this same text so they agree word for word.
    setPreparationProgress(null);
    const narration = getNarrationText(art.content);
    const narratedText = narration.text;
    if (narration.truncated) {
      setTruncationNotice(
        `Narrating the first ${narration.narratedWords.toLocaleString()} of ${narration.totalWords.toLocaleString()} words`
      );
    }

    // 1. Estimated word timings, shown until real ones arrive. The Soniox REST
    // stream carries no alignment data, so this is a guess -- see plan 022 for
    // the WebSocket path that replaces it with measured timestamps.
    const wordsList = narratedText.split(/\s+/).filter(Boolean);
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

    const voice = currSettings.sonioxVoice || 'Adrian';
    const clientId = getOrCreateClientId();
    let cacheUrl: string | null = null;
    if (canReadServerExactCache) {
      try {
        cacheUrl = await articleCacheKey({ sourceUrl: art.sourceUrl, content: narratedText });
      } catch (error) {
        console.warn('Exact track cache identity unavailable; continuing without server cache:', error);
      }
      if (!isCurrentLoad()) return;
    }
    const cancelCurrentStream = () => {
      activeStreamRef.current?.cancel();
      activeStreamRef.current = null;
    };

    // A fallback taken mid-article resumes where the listener was, not at the
    // top: capture the position (and whether audio was running) before the
    // engine is reset, and restore both once the replacement source is in.
    const captureFallbackPosition = () => {
      const index = eng.currentWordIndex;
      if (index >= RESUME_MIN_WORD_INDEX) pendingResumeIndex = index;
      return eng.isPlaying;
    };
    const restoreAfterFallback = (words: WordTiming[], wasPlaying: boolean) => {
      applyResume(words);
      if (wasPlaying && eng.playbackReady) eng.play();
    };

    const noteFallback = (reason: string | undefined) => {
      if (reason && isCurrentLoad()) setFallbackReason(reason.replace(/\s+/g, ' '));
    };
    const useRestFallback = (reason?: string) => {
      if (!isCurrentLoad()) return;
      noteFallback(reason);
      cancelCurrentStream();
      const wasPlaying = captureFallbackPosition();
      eng.stop();
      const text = narratedText;
      try {
        // REST has no timestamp envelope, so this deliberately keeps the
        // estimated/calibrated timeline. Speed remains client-side only.
        if (text.length <= REST_GET_MAX_CHARS) {
          const streamUrl =
            `/api/tts/stream?text=${encodeURIComponent(text)}` +
            `&voice=${encodeURIComponent(voice)}&speed=1.0&clientId=${encodeURIComponent(clientId)}`;
          eng.loadAudioUrl(streamUrl, initialWordTimings, totalDuration, () =>
            reportAudioFailure('the audio fallback could not be loaded')
          );
          setPlaybackStatus('degraded');
          restoreAfterFallback(initialWordTimings, wasPlaying);
          return;
        }

        // Read the POST body progressively too. Waiting for response.blob()
        // made a long article's fallback another whole-file loading screen.
        eng.startStreamingSession(initialWordTimings, totalDuration);
        setPlaybackStatus('degraded');
        const controller = new AbortController();
        activeStreamRef.current = { cancel: () => controller.abort() };
        void (async () => {
          const response = await withTimeout(fetch('/api/tts/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, voice, speed: 1.0, clientId }),
            signal: controller.signal,
          }), 20000, 'audio fallback connection');
          if (!response.ok) throw new Error(`audio fallback returned status ${response.status}`);
          if (!response.body) throw new Error('audio fallback returned no audio');
          const reader = response.body.getReader();
          let receivedBytes = 0;
          try {
            while (isCurrentLoad() && !controller.signal.aborted) {
              const result = await withTimeout(reader.read(), 20000, 'audio fallback');
              if (!isCurrentLoad() || controller.signal.aborted) return;
              if (result.done) break;
              receivedBytes += result.value.byteLength;
              eng.appendAudioChunk(result.value);
            }
            if (!isCurrentLoad() || controller.signal.aborted) return;
            if (receivedBytes === 0) throw new Error('audio fallback returned empty audio');
            eng.finishStreamingSession();
            const fitted = fitEstimatedTail(initialWordTimings, 0, eng.receivedAudioSeconds);
            eng.appendWordTimings(fitted, fitted.at(-1)?.end ?? totalDuration);
            restoreAfterFallback(fitted, wasPlaying);
            activeStreamRef.current = null;
          } finally {
            void reader.cancel().catch(() => {});
          }
        })().catch((error) => {
          if (!isCurrentLoad() || controller.signal.aborted) return;
          controller.abort();
          activeStreamRef.current = null;
          console.warn('Soniox REST audio could not be loaded:', error);
          reportAudioFailure(error instanceof Error ? error.message : 'the audio fallback failed');
        });
      } catch (error) {
        reportAudioFailure(error instanceof Error ? error.message : undefined);
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
        const temporaryKey = await withTimeout(
          requestTemporaryKey ? requestTemporaryKey(clientId) : temporaryKeyMutation.mutateAsync({ clientId }),
          LOOKUP_TIMEOUT_MS,
          'temporary key request'
        );
        if (!isCurrentLoad()) return;

        const accumulator = createWordTimingAccumulator(narratedText);
        const exactWords: WordTiming[] = [];
        let audioFinished = false;
        let completedBlob: Blob | null = null;
        let attemptActive = true;
        // Set once the timestamps can no longer be aligned to the article.
        // The audio is fine and paid for, so it keeps playing; only the sync
        // after this point falls back to the estimate.
        let timingsLost: string | null = null;
        eng.startStreamingSession(initialWordTimings, totalDuration);
        setPlaybackStatus('ready');

        const loseExactTimings = (error: unknown) => {
          if (timingsLost) return;
          timingsLost = error instanceof Error ? error.message : 'invalid timestamps';
          console.warn('Exact word timings lost; keeping the audio with estimated timing from here:', error);
          noteFallback(`exact word sync lost partway (${exactWords.length} words are exact): ${timingsLost}`);
          setPlaybackStatus('degraded');
        };

        const finalizeTimings = () => {
          if (!attemptActive || !isCurrentLoad()) return;
          if (!timingsLost) {
            try {
              exactWords.push(...accumulator.flush());
            } catch (error) {
              loseExactTimings(error);
            }
          }
          if (timingsLost) {
            const fitted = fitEstimatedTail(mergeAuthoritativePrefix(exactWords), exactWords.length, eng.receivedAudioSeconds);
            eng.appendWordTimings(fitted, fitted.at(-1)?.end ?? totalDuration, { authoritative: true });
            attemptActive = false;
            activeStreamRef.current = null;
            applyResume(fitted);
            return;
          }
          if (exactWords.length !== initialWordTimings.length) {
            attemptActive = false;
            useRestFallback('the word timings did not cover the article');
            return;
          }
          const exactDuration = exactWords.at(-1)?.end ?? 0;
          eng.appendWordTimings(exactWords, exactDuration, { authoritative: true });
          attemptActive = false;
          activeStreamRef.current = null;
          setPlaybackStatus('ready');
          applyResume(exactWords);

          if (completedBlob && canPersistExactTrack && cacheUrl) {
            const persistenceInput: PersistExactTrackInput = {
              url: cacheUrl,
              title: art.title,
              author: art.author,
              text: narratedText,
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
          text: narratedText,
          voice,
          handlers: {
            onAudio: (chunk) => {
              if (!attemptActive || !isCurrentLoad()) return;
              eng.appendAudioChunk(chunk);
            },
            onTimestamps: (batch) => {
              if (!attemptActive || !isCurrentLoad() || timingsLost) return;
              try {
                exactWords.push(...accumulator.append(batch));
              } catch (error) {
                loseExactTimings(error);
                return;
              }
              if (exactWords.length === 0 || exactWords.length > initialWordTimings.length) return;
              const merged = mergeAuthoritativePrefix(exactWords);
              eng.appendWordTimings(merged, merged.at(-1)?.end ?? totalDuration, { authoritative: true });
              // Resume only once the real timings reach the saved word and the
              // element can seek (progressive playback); the Blob-only path
              // resumes in finalizeTimings instead.
              if (eng.playbackReady && exactWords.length > pendingResumeIndex) applyResume(merged);
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
                captureFallbackPosition();
                eng.stop();
                void runWebSocketAttempt(1);
                return;
              }
              useRestFallback(`live stream failed: ${error.message}`);
            },
          },
        });
        if (attemptActive && isCurrentLoad() && eng.isStreaming) {
          activeStreamRef.current = stream;
        } else {
          stream.cancel();
        }
      } catch (error) {
        useRestFallback(
          error instanceof Error ? `could not start the live stream: ${error.message}` : 'could not start the live stream'
        );
      }
    };

    const loadCachedTrack = (cachedTrack: ExactTrackCacheEntry) => {
      let cacheFailed = false;
      eng.loadAudioUrl(cachedTrack.audioUrl, cachedTrack.words, cachedTrack.duration, () => {
        if (cacheFailed || !isCurrentLoad()) return;
        cacheFailed = true;
        if (durableNarration) {
          reportAudioFailure('Could not download the saved recording.');
        } else void runWebSocketAttempt(0);
      });
      eng.appendWordTimings(cachedTrack.words, cachedTrack.duration, { authoritative: true });
      setPlaybackStatus('ready');
      applyResume(cachedTrack.words);
    };

    if (canReadServerExactCache && cacheUrl) {
      try {
        const cachedTrack = await withTimeout(
          lookupExactTrack({ url: cacheUrl, voice }),
          LOOKUP_TIMEOUT_MS,
          'cache lookup'
        );
        if (!isCurrentLoad()) return;
        if (cachedTrack) {
          loadCachedTrack(cachedTrack);
          return;
        }
      } catch (error) {
        console.warn('Exact track cache lookup failed; continuing with synthesis:', error);
      }

      if (durableNarration) {
        const controller = new AbortController();
        activeStreamRef.current = { cancel: () => controller.abort() };
        const contentDigest = await articleContentDigest(narratedText);
        if (!isCurrentLoad()) return;
        setPlaybackStatus('ready');
        try {
          await playDurableNarration({
            engine: eng, initialWords: initialWordTimings, duration: totalDuration, signal: controller.signal,
            resumeWordIndex: pendingResumeIndex,
            onAudioError: () => { if (isCurrentLoad()) reportAudioFailure('The saved Soniox recording could not be played.'); },
            prepare: () => {
              const input = { text: narratedText, voice, clientId, title: art.title, author: art.author };
              return requestPregeneration ? requestPregeneration(input) : prepareNarrationMutation.mutateAsync(input);
            },
            page: from => narrationPage ? narrationPage({ contentDigest, voice, from }) : crpcClient.routers.narration.page.query({ contentDigest, voice, from }),
            pollMs: pregenerationPollMs,
            onProgress: (completed, total) => {
              if (isCurrentLoad()) setPreparationProgress(completed === total ? null : `Audio saved: ${completed} of ${total} sections. Preparation continues if you leave.`);
            },
          });
        } catch (error) {
          if (!isCurrentLoad() || controller.signal.aborted) return;
          reportAudioFailure(error instanceof Error ? error.message : 'Audio preparation failed.');
        }
        return;
      }

      // Cache miss -- but if the server is already synthesising this article
      // (it was added to the queue), wait for that instead of opening a
      // second, paid stream. Every article should cost one synthesis.
      try {
        const contentDigest = await articleContentDigest(narratedText);
        if (!isCurrentLoad()) return;
        let job = await withTimeout(
          lookupPregenerationStatus({ contentDigest, voice }),
          LOOKUP_TIMEOUT_MS,
          'pre-generation status'
        );
        if (!isCurrentLoad()) return;
        const isLiveJob = (candidate: PregenerationJobStatus) =>
          candidate.status === 'running' &&
          (candidate.startedAt === null || Date.now() - candidate.startedAt < PREGENERATION_STALE_MS);
        if (isLiveJob(job)) {
          setAwaitingPregeneration(true);
          const deadline = Date.now() + MAX_PREGENERATION_WAIT_MS;
          while (isLiveJob(job) && Date.now() < deadline && !skipPregenerationWaitRef.current) {
            await new Promise((resolve) => setTimeout(resolve, pregenerationPollMs));
            if (!isCurrentLoad()) return;
            job = await withTimeout(
              lookupPregenerationStatus({ contentDigest, voice }),
              LOOKUP_TIMEOUT_MS,
              'pre-generation status'
            );
          }
          if (!isCurrentLoad()) return;
          setAwaitingPregeneration(false);
          if (job.status === 'done') {
            const cachedTrack = await withTimeout(
              lookupExactTrack({ url: cacheUrl, voice }),
              LOOKUP_TIMEOUT_MS,
              'cache lookup'
            );
            if (!isCurrentLoad()) return;
            if (cachedTrack) {
              loadCachedTrack(cachedTrack);
              return;
            }
          }
        }
      } catch (error) {
        if (!isCurrentLoad()) return;
        setAwaitingPregeneration(false);
        console.warn('Pre-generation status unavailable; continuing with synthesis:', error);
      }
    }

    if (durableNarration) {
      reportAudioFailure('Saved audio could not be found.');
      return;
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
        lastWordIndex: cp.lastWordIndex || 0,
      }));
    }
    return savedArticles;
  }, [user, cloudPlaylist, savedArticles]);

  // The saved reading position for an article, from the cloud playlist when
  // signed in and the local library otherwise.
  const resumeIndexFor = (target: ArticleData): number => {
    const id = articleLibraryId(target);
    const item =
      effectiveSavedArticles.find((entry) => entry.id === id || entry.article.title === target.title) ??
      getSavedArticles().find((entry) => entry.id === id || entry.article.title === target.title);
    return resumeWordIndexFor(item);
  };

  const handleLoadNewArticle = (newArticle: ArticleData, options: { resume?: boolean } = {}) => {
    const resumeWordIndex = options.resume === false ? 0 : resumeIndexFor(newArticle);
    setPendingLoadUrl(null);
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
    // Opening starts or joins the same durable job used by the queue.
    loadArticleContent(newArticle, engine, settings, { resumeWordIndex });
  };

  // Fetch a remote article and open it, with the reader showing that a load
  // is in progress and saying so when it fails. Shared by the `?url=` deep
  // link, the `?read=` share link and the library's quick-paste field.
  const extractAndOpen = (url: string) => {
    const decodedUrl = url.trim();
    let host = decodedUrl;
    try {
      host = new URL(decodedUrl).hostname.replace(/^www\./, '');
    } catch {}

    const placeholder: ArticleData = {
      title: 'Loading article…',
      author: host,
      content: '',
      sourceUrl: decodedUrl,
      sourceType: 'article',
    };
    loadIdRef.current += 1;
    activeStreamRef.current?.cancel();
    activeStreamRef.current = null;
    engine.stop();
    engine.setWordTimings([], 0);
    setArticle(placeholder);
    setPendingLoadUrl(decodedUrl);
    setLoadError(null);
    setPlaybackStatus('synthesizing');

    return extractArticleMutation
      .mutateAsync({ url: decodedUrl, clientId: getOrCreateClientId() })
      .then((data) => {
        if (!data.title || !data.content) {
          throw new Error('No readable text could be extracted from this page.');
        }
        handleLoadNewArticle(data);
        return data;
      })
      .catch((err: unknown) => {
        console.warn('Failed to load article:', err);
        const reason = err instanceof Error && err.message ? err.message : 'Please try again.';
        setPendingLoadUrl(null);
        setArticle(SAMPLE_ARTICLE);
        setQueryUrl(null, { history: 'replace' });
        loadArticleContent(SAMPLE_ARTICLE, engine, settings);
        setLoadError(`Couldn’t read ${host}: ${reason}`);
        return null;
      });
  };

  const handleViewChange = (newView: 'reader' | 'queue' | 'settings' | 'auth') => {
    // Reading positions are written straight to storage while listening;
    // refresh the in-memory library when it is about to be shown.
    if (newView !== 'reader') setSavedArticles(getSavedArticles());
    setActiveView(newView === 'reader' ? null : newView, {
      history: newView === 'reader' ? 'replace' : 'push',
    });
  };

  const handleAddToQueue = (newArt: ArticleData) => {
    saveArticleToLibrary(newArt);
    setSavedArticles(getSavedArticles());
    pregenerateArticle(newArt);
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
    if (newSettings.defaultRate && Math.abs(newSettings.defaultRate - settings.defaultRate) > 0.05) {
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
      setPendingLoadUrl(null);
      setArticle(foundLocal.article);
      loadArticleContent(foundLocal.article, engine, settings, {
        resumeWordIndex: resumeWordIndexFor(foundLocal),
      });
      return;
    }

    void extractAndOpen(decodedUrl);
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
      revokeRestObjectUrl();
      engine.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  // "Voice off" mutes the narration; the kinetic timeline keeps running.
  useEffect(() => {
    engine.muted = !isVoiceEnabled;
  }, [isVoiceEnabled]);

  // Persist the reading position: locally for everyone (the library's
  // "Continue" reads it back), and to the cloud playlist when signed in.
  // Throttled, with a trailing write, so it fires during continuous playback
  // too. The old version was a 2s debounce keyed on the word index, which
  // during playback never fired at all -- progress only saved on pause.
  useEffect(() => {
    if (!article || playback.words.length === 0 || pendingLoadUrl) return;
    // Word 0 with no progress is a fresh load (or a reset), not a position
    // worth remembering -- and writing it would erase a real one.
    if (playback.currentWordIndex < RESUME_MIN_WORD_INDEX && playback.progress < 1) return;

    const save = () => {
      lastProgressSaveRef.current = Date.now();
      const artId = articleLibraryId(article);
      const progress = Number(playback.progress.toFixed(1));
      updateArticleProgress(artId, { progress, lastWordIndex: playback.currentWordIndex });
      if (user) {
        saveProgressMutation.mutate({
          articleId: artId,
          progress,
          lastWordIndex: playback.currentWordIndex,
          currentTime: Number(playback.currentTime.toFixed(2)),
          isCompleted: playback.progress >= 98,
        });
      }
    };

    const interval = playback.isPlaying ? PROGRESS_SAVE_INTERVAL_MS.playing : PROGRESS_SAVE_INTERVAL_MS.paused;
    const elapsed = Date.now() - lastProgressSaveRef.current;
    if (elapsed >= interval) {
      save();
      return;
    }
    const timer = setTimeout(save, interval - elapsed);
    return () => clearTimeout(timer);
  }, [playback.currentWordIndex, playback.isPlaying, user, pendingLoadUrl]);

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

    // `kinreader.com/r/<id>` forwards here as `?read=<id>` (plan 016, encoded-id
    // variant -- see utils/shareLink.ts). Resolve it into the ordinary `?url=`
    // load so the address bar ends up on a link that reopens the same article.
    const shareId = urlParams.get('read');
    if (shareId !== null) {
      const sharedUrl = decodeShareId(shareId);
      urlParams.delete('read');
      if (sharedUrl) {
        urlParams.set('url', sharedUrl);
        const search = urlParams.toString();
        window.history.replaceState({}, document.title, `${window.location.pathname}${search ? `?${search}` : ''}`);
        setQueryUrl(sharedUrl, { history: 'replace' });
      } else {
        const search = urlParams.toString();
        window.history.replaceState({}, document.title, `${window.location.pathname}${search ? `?${search}` : ''}`);
        setLoadError('That share link is not valid. Paste the article URL instead.');
      }
    }

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
            handleViewChange('reader');
            void extractAndOpen(urlToExtract);
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
        <ReaderFrame isPlaying={playback.isPlaying} theme={settings.readerTheme === 'light' ? 'light' : 'dark'}
          hintAvailable={!pendingLoadUrl && playback.playbackReady && playback.canStartPlayback && !loadError && playbackStatus !== 'error'}>
          {/* 1. Header Bar */}
          <Header
            pendingUrl={pendingLoadUrl}
            article={article}
            onOpenSettings={() => handleViewChange('settings')}
            onOpenInput={() => setIsInputOpen(true)}
            onOpenLibrary={() => handleViewChange('queue')}
            user={user}
            onOpenAuth={() => handleViewChange('auth')}
            remainingSeconds={Math.max(0, (playback.duration - playback.currentTime) / playback.rate)}
            viewMode={viewMode}
            onToggleViewMode={() => setViewMode(viewMode === 'kinetic' ? 'full' : 'kinetic')}
          />

          {/* 2. Kinetic Display */}
          <KineticDisplay
            isFetching={!!pendingLoadUrl}
            isPending={awaitingPregeneration || (!playback.isPlaying && (!playback.playbackReady || !playback.canStartPlayback || playback.currentTime === 0))}
            articleText={article.content}
            onTogglePlay={handleTogglePlay}
            onPageChange={setReaderPage}
            words={playback.words}
            currentWordIndex={playback.currentWordIndex}
            currentTime={playback.currentTime}
            onSelectWord={handleSelectWord}
            viewMode={viewMode}
            fontSize={settings.fontSize || 'md'}
            theme={settings.readerTheme === 'light' ? 'light' : 'dark'}
          />

          {/* 3. Bottom Controls */}
          <Controls
            isFetching={!!pendingLoadUrl}
            awaitingSavedRecording={awaitingPregeneration}
            pageNumber={readerPage.number}
            pageCount={readerPage.count}
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
            isPlayable={playback.playbackReady && (playback.canStartPlayback || playback.isPlaying)}
            bufferedProgress={playback.isStreaming && playback.duration > 0 ? playback.bufferedSeconds / playback.duration * 100 : undefined}
            loadingProgress={playback.isStreaming && playbackStatus !== 'error' ? {
              readySeconds: playback.bufferedAheadSeconds / playback.rate,
              targetSeconds: playback.bufferTargetSeconds / playback.rate,
              waiting: playback.isBuffering || (!playback.isPlaying && !playback.canStartPlayback),
            } : undefined}
            isBuffering={playbackStatus !== 'error' && (
              playback.isBuffering || (playback.isStreaming && !playback.isPlaying && !playback.canStartPlayback) ||
              (!playback.playbackReady && playbackStatus !== 'degraded')
            )}
            isDegraded={playbackStatus === 'degraded'}
            degradedMessage={
              fallbackReason ? `${ESTIMATED_TIMING_MESSAGE} Reason: ${fallbackReason}.` : ESTIMATED_TIMING_MESSAGE
            }
            isError={playbackStatus === 'error'}
            noticeMessage={loadError ?? undefined}
            onDismissNotice={() => setLoadError(null)}
            infoMessage={
              awaitingPregeneration
                ? 'Preparing audio… checking for a saved recording.'
                : preparationProgress ?? truncationNotice ?? undefined
            }
            infoBusy={awaitingPregeneration}
            infoAction={
              playbackStatus === 'error'
                ? { label: 'Retry audio', onClick: () => loadArticleContent(article, engine, settings, { resumeWordIndex: engine.currentWordIndex }) }
                : awaitingPregeneration
                ? {
                    label: 'Play now',
                    onClick: () => {
                      skipPregenerationWaitRef.current = true;
                    },
                  }
                : undefined
            }
          />
        </ReaderFrame>
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
