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
  signal: AbortSignal;
  prepare: () => Promise<unknown>;
  page: (from: number) => Promise<NarrationPage>;
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
  await bounded(options.prepare());
  alive();
  engine.startSavedSections(initialWords, options.duration, options.resumeWordIndex, options.onAudioError);
  let index = 0;
  let offset = 0;
  const exact: WordTiming[] = [];
  let lastProgress = Date.now();
  while (!signal.aborted) {
    const page = await bounded(options.page(index));
    alive();
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
