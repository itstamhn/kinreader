import { test, expect, spyOn } from 'bun:test';
import Hls from 'hls.js';
import { continuousWords, playContinuousNarration } from './continuousNarration';
import { SpeechEngine } from './speechEngine';

const initial = [{ text: 'one', start: 0, end: 1 }, { text: 'two', start: 1, end: 2 }];
test('growing continuous timings move only the estimated tail', () => {
  const exact = { text: 'one', start: 0.021333, end: 1.5 };
  expect(continuousWords(initial, { words: [exact], duration: 2.5, complete: false, total: 2, sections: [{}] })).toEqual([exact, { text: 'two', start: 2.5, end: 3.5 }]);
  expect(() => continuousWords(initial, { words: [exact], duration: 2.5, complete: true, total: 2, sections: [{}] })).toThrow('do not match');
});

test('a pending optional conversion falls back immediately without polling', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ status: 'pending' }, { status: 202 }); }) as unknown as typeof fetch;
  const engine = new SpeechEngine();
  engine.supportsContinuousAudio = async () => true;
  try {
    await expect(playContinuousNarration({ engine, source: { contentDigest: 'a'.repeat(64), voice: 'Adrian' }, initialWords: initial, signal: new AbortController().signal })).rejects.toThrow('unavailable');
    expect(requests).toBe(1);
  } finally { globalThis.fetch = originalFetch; engine.stop(); }
});

test('continuous VOD seeks request missing media immediately and resize buffer limits with speed', () => {
  const engine = new SpeechEngine();
  const e = engine as any;
  e.continuous = true;
  e.mode = 'audio';
  e.duration = 4000;
  e.words = initial;
  e.exactWordCount = 2;
  e.audio = { currentTime: 0, paused: true, seeking: false, buffered: { length: 1, start: () => 0, end: () => 180 }, pause() {} };
  e.hls = { config: {}, destroy() {} };
  engine.seekToProgress(75);
  expect(e.audio.currentTime).toBe(3000);
  expect(e.pendingSeekTime).toBeNull();
  engine.rate = 3.5;
  expect(e.hls.config.maxMaxBufferLength).toBe(315);
  expect(e.hls.config.frontBufferFlushThreshold).toBe(315);
  expect(e.hls.config.backBufferLength).toBe(105);
  e.hls = null;
});

test('continuous resume waits for exact timing then seeks once the section arrives', () => {
  const engine = new SpeechEngine();
  const e = engine as any;
  e.continuous = true;
  e.mode = 'audio';
  e.isStreaming = true;
  e.duration = 400;
  e.words = initial;
  e.exactWordCount = 1;
  e.continuousAvailableSeconds = 1;
  e.audio = { currentTime: 0, paused: true, seeking: false, buffered: { length: 0 }, pause() {} };
  engine.seekToWordIndex(1);
  expect(e.audio.currentTime).toBe(0);
  expect(e.pendingResumeWord).toBe(1);
  engine.updateContinuousTiming([initial[0]!, { text: 'two', start: 3.2, end: 4 }], 4, 2, true);
  expect(e.audio.currentTime).toBe(3.2);
  expect(e.pendingResumeWord).toBeNull();
  expect(e.pendingSeekTime).toBeNull();
});


test('Apple browsers with MediaSource keep continuous audio on HLS.js when speed rises to 3x', async () => {
  const vendor = Object.getOwnPropertyDescriptor(navigator, 'vendor');
  Object.defineProperty(navigator, 'vendor', { value: 'Apple Computer, Inc.', configurable: true });
  const supported = spyOn(Hls, 'isSupported').mockReturnValue(true);
  const load = spyOn(Hls.prototype, 'loadSource').mockImplementation(() => {});
  const attach = spyOn(Hls.prototype, 'attachMedia').mockImplementation(() => {});
  const engine = new SpeechEngine();
  const audio = (engine as any).audio;
  const native = spyOn(audio, 'canPlayType').mockReturnValue('probably');
  try {
    await engine.loadContinuousAudio('/recording/index.m3u8', initial, 4000, 1);
    engine.updateContinuousTiming(initial, 4000, initial.length, true);
    engine.rate = 3;
    expect(attach).toHaveBeenCalledWith(audio);
    expect(load).toHaveBeenCalledWith('/recording/index.m3u8');
    expect(audio.src).not.toContain('index.m3u8');
    expect(audio.playbackRate).toBe(3);
    expect(audio.muted).toBe(false);
    expect((engine as any).hls.config.maxMaxBufferLength).toBe(270);
    expect((engine as any).hls.config.startPosition).toBe(initial[1]!.start);
  } finally {
    engine.stop(); native.mockRestore(); supported.mockRestore(); load.mockRestore(); attach.mockRestore();
    if (vendor) Object.defineProperty(navigator, 'vendor', vendor);
    else delete (navigator as any).vendor;
  }
});

test('native-only HLS support cannot replace an existing recording with a silently fast-forwarding stream', async () => {
  const engine = new SpeechEngine();
  const supported = spyOn(Hls, 'isSupported').mockReturnValue(false);
  const audio = (engine as any).audio;
  const native = spyOn(audio, 'canPlayType').mockReturnValue('probably');
  engine.loadAudioUrl('/saved.mp3', initial, 2);
  engine.rate = 3;
  const previousSource = audio.src;
  try {
    expect(await engine.supportsContinuousAudio()).toBe(false);
    await expect(engine.loadContinuousAudio('/recording/index.m3u8', initial, 2)).rejects.toThrow('MediaSource');
    expect(audio.src).toBe(previousSource);
    expect(engine.rate).toBe(3);
  } finally { engine.stop(); native.mockRestore(); supported.mockRestore(); }
});


test('browser-paused buffering releases Play only with ready audio at the restored position', async () => {
  const supported = spyOn(Hls, 'isSupported').mockReturnValue(true);
  const load = spyOn(Hls.prototype, 'loadSource').mockImplementation(() => {});
  const attach = spyOn(Hls.prototype, 'attachMedia').mockImplementation(() => {});
  const engine = new SpeechEngine();
  const e = engine as any;
  const audio = e.audio;
  let ranges: Array<[number, number]> = [];
  let readiness = 4;
  Object.defineProperty(audio, 'buffered', { configurable: true, get: () => ({
    length: ranges.length, start: (i: number) => ranges[i]![0], end: (i: number) => ranges[i]![1],
  }) });
  Object.defineProperty(audio, 'readyState', { configurable: true, get: () => readiness });
  const play = spyOn(audio, 'play').mockResolvedValue(undefined);
  const refresh = () => engine.updateContinuousTiming(initial, 4000, initial.length, true);
  try {
    await engine.loadContinuousAudio('/recording/index.m3u8', initial, 4000);
    engine.rate = 3;
    refresh();
    expect(engine.getSnapshot().canStartPlayback).toBe(false);
    ranges = [[0, 2]];
    refresh();
    expect(engine.getSnapshot().canStartPlayback).toBe(false); // completed source still needs one listening second
    e.hls.pauseBuffering(); // the same public API used by ManagedMediaSource's endstreaming event
    refresh();
    expect(engine.getSnapshot().canStartPlayback).toBe(true);
    engine.play();
    expect(play).toHaveBeenCalledTimes(1);
    engine.pause();
    engine.seekToProgress(25);
    expect(engine.getSnapshot().canStartPlayback).toBe(false); // only distant bytes
    ranges = [[1000, 1000.3]];
    refresh();
    expect(engine.getSnapshot().canStartPlayback).toBe(false); // below underrun watermark
    ranges = [[1000, 1018]];
    readiness = 2;
    refresh();
    expect(engine.getSnapshot().canStartPlayback).toBe(false);
    readiness = 4;
    refresh();
    expect(engine.getSnapshot().canStartPlayback).toBe(true);
    ranges = [];
    refresh();
    expect(engine.getSnapshot().canStartPlayback).toBe(false);
  } finally {
    engine.stop(); play.mockRestore(); supported.mockRestore(); load.mockRestore(); attach.mockRestore();
  }
});
