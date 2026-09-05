import type { WordTiming } from '../types';
import type { SpeechEngine } from './speechEngine';

export interface ContinuousSource {
  contentDigest: string;
  voice: string;
  recordingId?: string;
  ownerToken?: string;
}
interface Timeline {
  complete: boolean;
  duration: number;
  words: WordTiming[];
  sections: unknown[];
  total: number;
}
export function continuousWords(initial: WordTiming[], timeline: Timeline) {
  if (timeline.words.some((word, i) => word.text !== initial[i]?.text) || (timeline.complete && timeline.words.length !== initial.length)) {
    throw new Error('Continuous word timings do not match the recording');
  }
  const tail = initial.slice(timeline.words.length);
  const join = tail[0]?.start ?? 0;
  return [...timeline.words, ...tail.map(word => ({ ...word, start: timeline.duration + word.start - join, end: timeline.duration + word.end - join }))];
}

export async function playContinuousNarration(options: {
  engine: SpeechEngine;
  source: ContinuousSource;
  initialWords: WordTiming[];
  signal: AbortSignal;
  resumeWordIndex?: number;
  onAudioError?: () => void;
  onWords?: (words: WordTiming[]) => void;
  onProgress?: (completed: number, total: number) => void;
}) {
  const { signal, engine } = options;
  // Check before requesting saved continuous media. Native-only browsers retain saved
  // sections, which support the same playback speeds without HLS trick play.
  if (!(await engine.supportsContinuousAudio())) throw new Error('Continuous audio requires MediaSource support');
  signal.throwIfAborted();
  const request = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) });
  signal.throwIfAborted();
  const descriptor = await request('/api/tts/continuous', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.source) });
  if (descriptor.status === 202 || !descriptor.ok) throw new Error('Continuous audio is unavailable');
  const urls: { timeline: string; playlist: string } = await descriptor.json();
  const response = await request(urls.timeline);
  if (!response.ok) throw new Error('Continuous audio is unavailable');
  const timeline: Timeline = await response.json();
  if (!timeline.complete || timeline.sections.length !== timeline.total) throw new Error('Continuous audio is unavailable');
  signal.throwIfAborted();
  const words = continuousWords(options.initialWords, timeline);
  await engine.loadContinuousAudio(urls.playlist, words, timeline.duration, options.resumeWordIndex, options.onAudioError, signal);
  engine.updateContinuousTiming(words, timeline.duration, timeline.words.length, true);
  options.onWords?.(timeline.words);
  options.onProgress?.(timeline.sections.length, timeline.total);
}
