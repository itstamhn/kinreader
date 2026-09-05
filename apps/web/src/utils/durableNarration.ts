import { playContinuousNarration, type ContinuousSource } from './continuousNarration';
import type { NarrationPage } from '@kinreader/backend/tts/durableNarration';
import type { WordTiming } from '../types';
import type { SpeechEngine } from './speechEngine';

/** Downloads only completed, saved sections. Provider retries happen on the
 * server and cannot replace bytes or timings already given to the player. */
export async function playDurableNarration(options: {
  engine: SpeechEngine;
  initialWords: WordTiming[];
  duration: number;
  resumeWordIndex?: number;
  readSavedFirst?: boolean;
  continuousSource?: ContinuousSource;
  signal: AbortSignal;
  prepare: () => Promise<unknown>;
  page: (from: number, completedManifest?: boolean) => Promise<NarrationPage>;
  fetchAudio?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  pollMs?: number;
  onAudioError?: () => void;
  onWords?: (words: WordTiming[]) => void;
  onProgress?: (completed: number, total: number) => void;
}): Promise<void> {
  const { engine, initialWords, signal } = options;
  const alive = () => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('The audio service did not respond. Your saved audio is safe.')); }, 20000);
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  const fetchAudio = options.fetchAudio ?? (async (url, signal) => {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
    if (!response.ok) throw new Error('Could not download saved audio');
    return new Uint8Array(await response.arrayBuffer());
  });
  // Recording-backed opens try the read-only HLS artifact first. Its fallback
  // manifest is requested only when HLS is absent, so successful opens do not
  // download the same timing metadata twice.
  let firstPage: NarrationPage | null = null;
  let resumeWord = options.resumeWordIndex;
  let resumePlaying = false;
  const readSavedFirst = Boolean(options.continuousSource?.recordingId || options.readSavedFirst);
  if (options.continuousSource && readSavedFirst) {
    try {
      await playContinuousNarration({
        ...options,
        source: options.continuousSource,
      });
      return;
    } catch (error) {
      alive();
      resumeWord = engine.currentWordIndex || resumeWord;
      resumePlaying = engine.isPlaying;
      console.warn('Continuous packaging unavailable; using saved sections.', error);
    }
  }
  if (readSavedFirst) firstPage = await bounded(options.page(0, true));
  if (!options.continuousSource?.recordingId && firstPage?.status !== 'done') {
    await bounded(options.prepare());
    if (firstPage?.status === 'none') firstPage = null;
  }
  alive();
  engine.startSavedSections(initialWords, options.duration, resumeWord, options.onAudioError);
  let index = 0;
  let offset = 0;
  const exact: WordTiming[] = [];
  let lastProgress = Date.now();
  if (firstPage?.status === 'done' && firstPage.total > 0) {
    const manifest = [...firstPage.sections];
    if (manifest.length !== firstPage.total || manifest.length > 1000) throw new Error('Saved audio metadata is incomplete');
    const starts: number[] = [];
    const wordStarts: number[] = [];
    const exact: WordTiming[] = [];
    let offset = 0;
    for (const section of manifest) {
      if (section.index !== starts.length) throw new Error('Saved audio sections are out of order');
      starts.push(offset);
      wordStarts.push(exact.length);
      exact.push(
        ...section.words.map((word) => ({
          ...word,
          start: word.start + offset,
          end: word.end + offset,
        }))
      );
      offset += section.duration;
    }
    if (exact.length !== initialWords.length || exact.some((word, i) => word.text !== initialWords[i]?.text)) {
      throw new Error('Saved word timings do not match this article');
    }
    engine.appendWordTimings(exact, offset, { authoritative: true });
    options.onWords?.(exact);

    const targetWord = resumeWord ?? 0;
    let startSection = manifest.findIndex((section, sectionIndex) => wordStarts[sectionIndex]! + section.words.length > targetWord);
    if (startSection < 0) startSection = manifest.length - 1;
    engine.setSavedSectionStart(starts[startSection]!, wordStarts[startSection]!);
    engine.markStreamingSourceFinished();

    let earliestLoaded = startSection;
    let backwardLoad: Promise<void> | null = null;
    let pendingBackward: number | null = null;
    const loadBackward = () => {
      if (backwardLoad || pendingBackward === null || pendingBackward >= earliestLoaded) return;
      const requested = pendingBackward;
      pendingBackward = null;
      const through = earliestLoaded;
      backwardLoad = (async () => {
        const sections = [];
        for (let sectionIndex = requested; sectionIndex < through; sectionIndex += 1) {
          const section = manifest[sectionIndex]!;
          const bytes = await bounded(fetchAudio(section.audioUrl, signal));
          alive();
          sections.push({ bytes, start: starts[sectionIndex]!, duration: section.duration });
        }
        earliestLoaded = requested;
        engine.prependSavedSections(sections);
      })().catch(error => {
        if (!signal.aborted) options.onAudioError?.();
        console.warn('Could not load an earlier saved section.', error);
      }).finally(() => {
        backwardLoad = null;
        loadBackward();
      });
    };
    engine.setSavedSectionLoader(targetTime => {
      let requested = starts.findIndex((start, sectionIndex) => targetTime < start + manifest[sectionIndex]!.duration);
      if (requested < 0) requested = manifest.length - 1;
      pendingBackward = pendingBackward === null ? requested : Math.min(pendingBackward, requested);
      loadBackward();
    });

    for (let sectionIndex = startSection; sectionIndex < manifest.length; sectionIndex += 1) {
      const section = manifest[sectionIndex]!;
      const bytes = await bounded(fetchAudio(section.audioUrl, signal));
      alive();
      engine.appendSavedSection(bytes, section.duration, section.words.length);
      if (resumePlaying) {
        engine.play();
        resumePlaying = false;
      }
    }
    engine.finishStreamingSession();
    return;
  }
  while (!signal.aborted) {
    const page = index === 0 && firstPage ? firstPage : await bounded(options.page(index));
    firstPage = null;
    alive();
    if (page.status === 'done') engine.markStreamingSourceFinished();
    options.onProgress?.(page.completed, page.total);
    for (const section of page.sections) {
      if (section.index !== index) throw new Error('Saved audio sections are out of order');
      const bytes = await bounded(fetchAudio(section.audioUrl, signal));
      alive();
      exact.push(...section.words.map(w => ({ ...w, start: w.start + offset, end: w.end + offset })));
      offset += section.duration;
      if (exact.some((word, i) => word.text !== initialWords[i]?.text)) throw new Error('Saved word timings do not match this article');
      const tail = initialWords.slice(exact.length);
      const join = tail[0]?.start ?? 0;
      const words = [...exact, ...tail.map(w => ({ ...w, start: offset + w.start - join, end: offset + w.end - join }))];
      engine.appendWordTimings(words, Math.max(offset, words.at(-1)?.end ?? 0), { authoritative: true });
      engine.appendSavedSection(bytes, section.duration, section.words.length);
      if (resumePlaying) { engine.play(); resumePlaying = false; }
      options.onWords?.(exact);
      index++;
      lastProgress = Date.now();
    }
    if (page.total > 0 && index === page.total) {
      if (exact.length !== initialWords.length) throw new Error('Saved word timings are incomplete');
      engine.appendWordTimings(exact, offset, { authoritative: true });
      engine.finishStreamingSession();
      options.onWords?.(exact);
      return;
    }
    if (page.error || (page.status === 'failed' && !page.sections.length)) throw new Error(page.error ?? 'A section could not be prepared. Retry will keep the sections already saved.');
    if (Date.now() - lastProgress > 210000) throw new Error('Audio preparation stalled. Retry will keep the sections already saved.');
    if (!page.sections.length) await bounded(new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1500)));
  }
}
