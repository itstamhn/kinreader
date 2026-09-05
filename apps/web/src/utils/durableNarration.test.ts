import { test, expect } from 'bun:test';
import { playDurableNarration } from './durableNarration';
import { SpeechEngine } from './speechEngine';
import type { WordTiming } from '../types';

test('saved section offsets use audio duration and keep exact timings across polls', async () => {
  const engine = new SpeechEngine();
  const bytes: number[] = [];
  let starts = 0;
  let words: WordTiming[] = [];
  engine.startStreamingSession = () => { starts++; return true; };
  engine.appendAudioChunk = chunk => { bytes.push(chunk[0]!); };
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
  engine.startStreamingSession = () => { starts++; return true; };
  engine.appendAudioChunk = chunk => { bytes.push(chunk[0]!); };
  engine.appendWordTimings = () => {};
  await expect(playDurableNarration({ engine, initialWords: [{ text: 'One.', start: 0, end: 1 }, { text: 'Two.', start: 1, end: 2 }], duration: 2, signal: new AbortController().signal,
    prepare: async () => { prepares++; }, fetchAudio: async () => new Uint8Array([1]),
    page: async from => ({ status: from === 0 ? 'running' : 'failed', total: 2, completed: 1, error: from === 0 ? null : 'provider interrupted', sections: from === 0 ? [{ index: 0, audioUrl: 'one.mp3', duration: 1, words: [{ text: 'One.', start: 0, end: 0.8 }] }] : [] }),
  })).rejects.toThrow('provider interrupted');
  expect(starts).toBe(1);
  expect(prepares).toBe(1);
  expect(bytes).toEqual([1]);
});
