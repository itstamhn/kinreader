import { test, expect } from 'bun:test';
import { playDurableNarration } from './durableNarration';
import { SpeechEngine } from './speechEngine';
import type { WordTiming } from '../types';

test('saved section offsets use audio duration and keep exact timings across polls', async () => {
  const engine = new SpeechEngine();
  const bytes: number[] = [];
  let starts = 0;
  let words: WordTiming[] = [];
  engine.startSavedSections = () => { starts++; return true; };
  engine.appendSavedSection = chunk => { bytes.push(chunk[0]!); };
  engine.appendWordTimings = (updated, _duration, opts) => { expect(opts?.authoritative).toBe(true); words = updated; };
  engine.finishStreamingSession = () => new Blob();
  let calls = 0;
  const initialWords = [{ text: 'One.', start: 0, end: 1 }, { text: 'Two.', start: 1, end: 2 }];
  await playDurableNarration({
    engine, initialWords, duration: 2, signal: new AbortController().signal, pollMs: 1,
    prepare: async () => {},
    fetchAudio: async url => new Uint8Array([Number(url)]),
    page: async from => {
      calls++;
      if (calls === 2) return { status: 'running', total: 2, completed: 1, error: null, sections: [] };
      return { status: from === 0 ? 'running' : 'done', total: 2, completed: from + 1, error: null, sections: [{ index: from, audioUrl: String(from + 1), duration: 2, words: [{ text: initialWords[from]!.text, start: 0.1, end: 1 }] }] };
    },
  });
  expect(starts).toBe(1);
  expect(bytes).toEqual([1, 2]);
  expect(words).toEqual([{ text: 'One.', start: 0.1, end: 1 }, { text: 'Two.', start: 2.1, end: 3 }]);
});

test('a failed section does not reset or synthesize completed audio', async () => {
  const engine = new SpeechEngine();
  let starts = 0;
  let prepares = 0;
  const bytes: number[] = [];
  engine.startSavedSections = () => { starts++; return true; };
  engine.appendSavedSection = chunk => { bytes.push(chunk[0]!); };
  engine.appendWordTimings = () => {};
  await expect(playDurableNarration({ engine, initialWords: [{ text: 'One.', start: 0, end: 1 }, { text: 'Two.', start: 1, end: 2 }], duration: 2, signal: new AbortController().signal,
    prepare: async () => { prepares++; }, fetchAudio: async () => new Uint8Array([1]),
    page: async from => ({ status: from === 0 ? 'running' : 'failed', total: 2, completed: 1, error: from === 0 ? null : 'provider interrupted', sections: from === 0 ? [{ index: 0, audioUrl: 'one.mp3', duration: 1, words: [{ text: 'One.', start: 0, end: 0.8 }] }] : [] }),
  })).rejects.toThrow('provider interrupted');
  expect(starts).toBe(1);
  expect(prepares).toBe(1);
  expect(bytes).toEqual([1]);
});

test('continuous playback uses saved packaging without downloading MP3s again', async () => {
  const originalFetch = globalThis.fetch;
  const engine = new SpeechEngine();
  const words = [{ text: 'One.', start: 0.021333, end: 1 }, { text: 'Two.', start: 2.1, end: 3 }];
  let prepared = 0;
  let loaded = '';
  let completed = false;
  engine.supportsContinuousAudio = async () => true;
  engine.loadContinuousAudio = async url => { loaded = url; };
  engine.updateContinuousTiming = (updated, duration, count, complete) => {
    expect(updated).toEqual(words); expect(duration).toBe(4); expect(count).toBe(2); completed = complete;
  };
  engine.startSavedSections = () => { throw new Error('Unexpected MP3 fallback'); };
  globalThis.fetch = (async (url: string) => url === '/api/tts/continuous'
    ? Response.json({ playlist: '/saved/index.m3u8', timeline: '/saved/timeline.json' })
    : Response.json({ words, duration: 4, complete: true, sections: [{}, {}], total: 2 })) as typeof fetch;
  try {
    await playDurableNarration({ engine, initialWords: words, duration: 4, continuousSource: { contentDigest: 'a'.repeat(64), voice: 'Adrian', recordingId: 'saved-recording' }, signal: new AbortController().signal,
      prepare: async () => { prepared++; }, page: async () => ({ status: 'done', total: 1, completed: 1, error: null, sections: [] }) });
    expect(prepared).toBe(0); expect(loaded).toBe('/saved/index.m3u8'); expect(completed).toBe(true);
  } finally { globalThis.fetch = originalFetch; }
});


test('native-only browsers use saved audio at 3x without requesting a conversion', async () => {
  const originalFetch = globalThis.fetch;
  const engine = new SpeechEngine();
  const words = [{ text: 'One.', start: 0, end: 1 }];
  let prepared = 0;
  let saved = false;
  engine.rate = 3;
  engine.supportsContinuousAudio = async () => false;
  engine.startSavedSections = () => { saved = true; };
  engine.appendSavedSection = () => {};
  engine.appendWordTimings = () => {};
  engine.finishStreamingSession = () => new Blob();
  globalThis.fetch = (async () => { throw new Error('Unexpected packaging request'); }) as unknown as typeof fetch;
  try {
    await playDurableNarration({ engine, initialWords: words, duration: 1,
      continuousSource: { contentDigest: 'a'.repeat(64), voice: 'Adrian', recordingId: 'saved-recording' }, signal: new AbortController().signal,
      prepare: async () => { prepared++; }, fetchAudio: async () => new Uint8Array([1]),
      page: async () => ({ status: 'done', total: 1, completed: 1, error: null,
        sections: [{ index: 0, audioUrl: 'saved.mp3', duration: 1, words }] }),
    });
    expect(prepared).toBe(0);
    expect(saved).toBe(true);
    expect(engine.rate).toBe(3);
  } finally { globalThis.fetch = originalFetch; }
});

test('completed recording resume fetches the target section first from one read-only manifest', async () => {
  const engine = new SpeechEngine();
  const initialWords = Array.from({ length: 6 }, (_, index) => ({ text: `w${index}`, start: index, end: index + 0.8 }));
  const fetched: string[] = [];
  let manifestFlag = false;
  let start: [number, number] | undefined;
  let loadEarlier: ((seconds: number) => void) | undefined;
  const prepended: number[][] = [];
  let holdEarlier = false;
  let releaseEarlier: (() => void) | undefined;
  engine.supportsContinuousAudio = async () => false;
  engine.startSavedSections = () => {};
  engine.setSavedSectionStart = (seconds, words) => { start = [seconds, words]; };
  engine.markStreamingSourceFinished = () => {};
  engine.setSavedSectionLoader = loader => { loadEarlier = loader; };
  engine.prependSavedSections = sections => { prepended.push(sections.map(section => section.start)); };
  engine.appendSavedSection = () => {};
  engine.appendWordTimings = () => {};
  engine.finishStreamingSession = () => new Blob();
  await playDurableNarration({ engine, initialWords, duration: 6, resumeWordIndex: 4,
    continuousSource: { contentDigest: 'a'.repeat(64), voice: 'Adrian', recordingId: 'saved' }, signal: new AbortController().signal,
    prepare: async () => { throw new Error('prepare must stay read-only'); },
    fetchAudio: async url => { fetched.push(url); if (holdEarlier && url === 'section-1') await new Promise<void>(resolve => { releaseEarlier = resolve; }); return new Uint8Array([1]); },
    page: async (_from, manifest) => { manifestFlag = manifest === true; return { status: 'done', total: 6, completed: 6, error: null,
      sections: initialWords.map((word, index) => ({ index, audioUrl: `section-${index}`, duration: 1, words: [{ ...word, start: 0, end: 0.8 }] })) }; },
  });
  expect(manifestFlag).toBe(true);
  expect(start).toEqual([4, 4]);
  expect(fetched).toEqual(['section-4', 'section-5']);
  holdEarlier = true;
  loadEarlier?.(1.2);
  await Promise.resolve();
  loadEarlier?.(0.2);
  releaseEarlier?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetched).toEqual(['section-4', 'section-5', 'section-1', 'section-2', 'section-3', 'section-0']);
  expect(prepended).toEqual([[1, 2, 3], [0]]);
});
