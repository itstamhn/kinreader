import { test, expect } from 'bun:test';
import { SpeechEngine } from './speechEngine';

// `useSyncExternalStore` calls `getSnapshot()` on every render and compares
// the result with `Object.is` against what it returned last time. If
// `getSnapshot` allocates a fresh object on every call, React sees "the
// store changed" on every single render and re-renders forever -- an
// infinite loop with no error message, just a frozen/crashing tab (plan
// 018, Step 3's central footgun). This test is exactly what would catch a
// naive `getSnapshot() { return { ...fields }; }` implementation: with one,
// `toBe` below fails immediately because the two calls return different
// object references even though nothing changed in between.
test('getSnapshot returns the identical reference across calls with no intervening change', () => {
  const engine = new SpeechEngine();

  const first = engine.getSnapshot();
  const second = engine.getSnapshot();

  expect(second).toBe(first);

  // Calling it many more times without touching the engine must keep
  // returning that same reference -- not just "equal by value" twice in a
  // row.
  for (let i = 0; i < 10; i++) {
    expect(engine.getSnapshot()).toBe(first);
  }
});

test('getSnapshot returns a new reference only after the engine actually changes', () => {
  const engine = new SpeechEngine();
  const before = engine.getSnapshot();

  engine.loadBrowserText('one two three', [
    { text: 'one', start: 0, end: 0.2 },
    { text: 'two', start: 0.2, end: 0.4 },
    { text: 'three', start: 0.4, end: 0.6 },
  ]);

  const after = engine.getSnapshot();
  expect(after).not.toBe(before);
  expect(after.words.length).toBe(3);
  expect(after.mode).toBe('browser');

  // And it is stable again immediately afterwards.
  expect(engine.getSnapshot()).toBe(after);
});

test('subscribe returns an unsubscribe that actually detaches the listener', () => {
  const engine = new SpeechEngine();

  let calls = 0;
  const unsubscribe = engine.subscribe(() => {
    calls += 1;
  });

  // loadBrowserText notifies twice: once from the internal stop() it opens
  // with (reset to word 0), once for the words/mode/duration it then loads.
  engine.loadBrowserText('hello world', [
    { text: 'hello', start: 0, end: 0.3 },
    { text: 'world', start: 0.3, end: 0.6 },
  ]);
  const callsWhileSubscribed = calls;
  expect(callsWhileSubscribed).toBeGreaterThan(0);

  unsubscribe();

  // Further changes must not reach the now-unsubscribed listener.
  engine.loadBrowserText('goodbye', [{ text: 'goodbye', start: 0, end: 0.5 }]);
  expect(calls).toBe(callsWhileSubscribed);
});

test('subscribe supports multiple independent listeners', () => {
  const engine = new SpeechEngine();

  let a = 0;
  let b = 0;
  const unsubA = engine.subscribe(() => {
    a += 1;
  });
  const unsubB = engine.subscribe(() => {
    b += 1;
  });

  engine.loadBrowserText('x', [{ text: 'x', start: 0, end: 0.1 }]);
  expect(a).toBeGreaterThan(0);
  expect(a).toBe(b); // both listeners heard the exact same notifications

  const aAfterFirstLoad = a;
  unsubA();
  engine.loadBrowserText('y', [{ text: 'y', start: 0, end: 0.1 }]);
  expect(a).toBe(aAfterFirstLoad); // unsubscribed, stays put
  expect(b).toBeGreaterThan(aAfterFirstLoad); // still subscribed, kept counting

  unsubB();
});

// Regression test for plan 018, Step 4: a rejected/empty synthesis used to
// fall back to the on-device voice completely silently -- there was no way
// for a caller to distinguish "neural voice" from "failed, using the
// fallback" other than reading `mode`. `loadBrowserText` (the fallback path)
// must land the engine in 'browser' mode with the estimated word timings
// so the caller (App.tsx) can surface that as 'degraded' rather than
// 'ready'.
test('falling back to on-device speech is visible via engine.mode, not silent', () => {
  const engine = new SpeechEngine();

  engine.loadAudioUrl('/sample_audio.mp3', [{ text: 'hi', start: 0, end: 0.2 }], 0.2);
  expect(engine.mode).toBe('audio');

  // Simulate the synthesis-failed fallback loadArticleContent takes.
  engine.loadBrowserText('fallback text', [{ text: 'fallback', start: 0, end: 0.4 }]);
  expect(engine.mode).toBe('browser');
  expect(engine.getSnapshot().mode).toBe('browser');
});

// --- Audio/highlight sync -------------------------------------------------

// A stand-in for the <audio> element. Only the properties the sync loop
// reads are modelled; each test drives `currentTime`/`paused` by hand to
// stage the exact condition it is about.
function fakeAudio(overrides: Record<string, any> = {}) {
  return {
    src: '',
    currentTime: 0,
    duration: NaN,
    paused: false,
    ended: false,
    seeking: false,
    readyState: 4,
    networkState: 1,
    buffered: { length: 0, end: () => 0 },
    playbackRate: 1,
    defaultPlaybackRate: 1,
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    ...overrides,
  };
}

function attach(engine: SpeechEngine, audio: any, words: { text: string; start: number; end: number }[]) {
  (engine as any).audio = audio;
  engine.mode = 'audio';
  engine.words = words;
  engine.duration = words[words.length - 1]!.end;
  engine.isPlaying = true;
}

// Evenly spaced one-word-per-second timings, `count` seconds long.
function evenWords(count: number) {
  return Array.from({ length: count }, (_, i) => ({ text: `w${i}`, start: i, end: i + 1 }));
}

// The bug this file's sync fixes: the loop used to advance its own clock by
// `dt * rate` whenever the audio element was not moving, and a `< 2.0s` drift
// gate then refused to ever trust the element again. Raising the speed makes
// a streamed Soniox MP3 stall routinely -- playback drains it faster than it
// arrives -- so the words would run away from the voice and never come back.
test('a stalled stream does not let the highlight run away from the audio at high speed', () => {
  const engine = new SpeechEngine();
  const audio = fakeAudio({ currentTime: 1.0 });
  attach(engine, audio, evenWords(60));
  engine.rate = 3.5;

  // Ten wall-clock seconds of frames while the element sits frozen at 1.0s.
  for (let i = 0; i < 100; i++) {
    (engine as any).syncFromAudioTick(0.1);
  }

  // At most the small coast budget ahead of where the voice actually is --
  // the old behaviour landed at 1.0 + 100 * 0.1 * 3.5 = 36s.
  expect(engine.currentTime).toBeLessThanOrEqual(1.0 + 0.35 + 1e-6);
  expect(engine.currentTime).toBeGreaterThanOrEqual(1.0);
});

// ...and once the element starts moving again the highlight snaps back onto
// it, rather than staying stuck ahead behind a drift gate.
test('the highlight re-locks onto the audio clock as soon as the stream resumes', () => {
  const engine = new SpeechEngine();
  const audio = fakeAudio({ currentTime: 1.0 });
  attach(engine, audio, evenWords(60));
  engine.rate = 3.5;

  for (let i = 0; i < 100; i++) {
    (engine as any).syncFromAudioTick(0.1);
  }
  expect(engine.currentTime).toBeGreaterThan(1.0); // coasted a little

  audio.currentTime = 1.4;
  (engine as any).syncFromAudioTick(0.1);
  expect(engine.currentTime).toBe(1.4);
  expect(engine.getSnapshot().currentWordIndex).toBe(1);
});

// `currentTime` is media time, so the element already advances it at
// `playbackRate` -- and the word timings are media time too. Anything that
// scales the timeline by the rate a second time desyncs by exactly that
// factor, which is what "not following when I change speed" looked like.
test('the highlight tracks audio media time exactly, at any playback rate', () => {
  for (const rate of [0.8, 1, 2, 3.5]) {
    const engine = new SpeechEngine();
    const audio = fakeAudio();
    attach(engine, audio, evenWords(60));
    engine.rate = rate;

    // One wall second of frames: the element advances `rate` media seconds.
    // Assigned rather than accumulated so float drift cannot nudge the final
    // position just under a word boundary.
    for (let i = 1; i <= 10; i++) {
      audio.currentTime = Number(((i * 0.1 * rate).toFixed(6)));
      (engine as any).syncFromAudioTick(0.1);
    }

    expect(engine.currentTime).toBeCloseTo(rate, 5);
    expect(engine.getSnapshot().currentWordIndex).toBe(Math.floor(rate));
  }
});

// The estimated ~175 WPM timeline App.tsx builds is routinely shorter than
// the real Soniox audio. `duration` used to be pinned to that estimate on
// every tick, so playback "ended" while the voice was still talking.
test('an estimated timeline shorter than the real audio does not end playback early', () => {
  const engine = new SpeechEngine();
  const audio = fakeAudio({ duration: 20 });
  attach(engine, audio, evenWords(10)); // estimate says 10s, audio is really 20s

  for (let t = 0.5; t <= 12; t += 0.5) {
    audio.currentTime = t;
    (engine as any).syncFromAudioTick(0.5);
  }

  expect(engine.isPlaying).toBe(true);
  expect(engine.duration).toBe(20);
  // Past the last estimated word, the highlight holds there instead of stopping.
  expect(engine.getSnapshot().currentWordIndex).toBe(9);
});

test('ending playback pauses the audio element instead of leaving it talking', () => {
  const engine = new SpeechEngine();
  const audio = fakeAudio({ duration: 10 });
  attach(engine, audio, evenWords(10));

  audio.currentTime = 10;
  (engine as any).syncFromAudioTick(0.1);

  expect(engine.isPlaying).toBe(false);
  expect(audio.paused).toBe(true);
});

// The estimate is a guess at the pace of a voice we never got timings for
// (Soniox's REST stream carries no alignment data). Once the whole file has
// arrived and reports a real duration, the timeline is stretched onto it.
test('the estimated word timeline is rescaled to the real audio duration once known', () => {
  const engine = new SpeechEngine();
  const audio = fakeAudio({
    duration: 20,
    networkState: 1,
    buffered: { length: 1, start: () => 0, end: () => 20 },
  });
  attach(engine, audio, evenWords(10));

  (engine as any).calibrateToAudioDuration();

  expect(engine.duration).toBe(20);
  expect(engine.words[0]!.end).toBe(2); // 1s estimated -> 2s real
  expect(engine.words[9]!.end).toBe(20);
});

// A duration that the buffer does not yet cover is a chunked MP3's growing
// estimate, not the real length -- rescaling onto it would be worse than
// leaving the estimate alone.
test('rescaling waits for a duration the buffer actually covers', () => {
  const engine = new SpeechEngine();
  const audio = fakeAudio({
    duration: 4,
    buffered: { length: 1, start: () => 0, end: () => 4 },
    networkState: 2, // NETWORK_LOADING -- still pulling bytes
  });
  attach(engine, audio, evenWords(10));

  (engine as any).calibrateToAudioDuration();

  expect(engine.words[9]!.end).toBe(10); // untouched
});

// Removing the standard-source preference would make browsers with both MSE
// variants select ManagedMediaSource, whose lifecycle is controlled by iOS.
// This test also catches losing the explicit progressive-playback signal.
test('streaming prefers MediaSource and exposes progressive playback availability', () => {
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const created: string[] = [];

  class FakeMediaSource {
    static isTypeSupported() { return true; }
    readyState = 'closed';
    addEventListener() {}
    removeEventListener() {}
  }
  class FakeManagedMediaSource extends FakeMediaSource {}

  (window as any).MediaSource = FakeMediaSource;
  (window as any).ManagedMediaSource = FakeManagedMediaSource;
  URL.createObjectURL = (source: any) => {
    created.push(source.constructor.name);
    return `blob:${source.constructor.name}`;
  };

  try {
    const engine = new SpeechEngine();
    const progressive = engine.startStreamingSession(evenWords(2), 2);

    expect(progressive).toBe(true);
    expect(engine.getSnapshot().progressivePlaybackAvailable).toBe(true);
    expect(engine.getSnapshot().playbackReady).toBe(true);
    expect(created).toEqual(['FakeMediaSource']);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
  }
});

// iOS exposes ManagedMediaSource without standard MediaSource. Removing this
// guarded fallback turns a progressively playable stream into a completed-Blob
// wait even though the browser supports an MSE-compatible source.
test('streaming uses ManagedMediaSource when it is the only supported source', () => {
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const created: string[] = [];

  class FakeManagedMediaSource {
    static isTypeSupported() { return true; }
    readyState = 'closed';
    addEventListener() {}
    removeEventListener() {}
  }

  (window as any).MediaSource = undefined;
  (window as any).ManagedMediaSource = FakeManagedMediaSource;
  URL.createObjectURL = (source: any) => {
    created.push(source.constructor.name);
    return 'blob:managed-source';
  };

  try {
    const engine = new SpeechEngine();

    expect(engine.startStreamingSession(evenWords(1), 1)).toBe(true);
    expect(created).toEqual(['FakeManagedMediaSource']);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
  }
});

// Without MSE, finish must still make the complete bytes playable. A missing
// Blob URL here is the iPhone Safari silent-playback failure from the plan.
test('streaming without a supported source plays in parts and is playable from the start', async () => {
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const partBlobs: Blob[] = [];

  (window as any).MediaSource = undefined;
  (window as any).ManagedMediaSource = undefined;
  URL.createObjectURL = (source: any) => {
    if (source instanceof Blob) partBlobs.push(source);
    return `blob:part-${partBlobs.length}`;
  };

  try {
    const engine = new SpeechEngine();
    const progressive = engine.startStreamingSession(evenWords(1), 1);
    // Progressive in parts: Play is allowed immediately and holds until audio exists.
    expect(progressive).toBe(true);
    expect(engine.getSnapshot().progressivePlaybackAvailable).toBe(true);
    expect(engine.getSnapshot().playbackReady).toBe(true);
    engine.appendAudioChunk(new Uint8Array([1, 2]));
    engine.appendAudioChunk(new Uint8Array([3]));
    // Not MP3 frames, so no part can be cut yet.
    expect(partBlobs).toHaveLength(0);

    const blob = engine.finishStreamingSession();

    // The tail becomes the single final part, and the persistence blob holds every byte.
    expect(partBlobs).toHaveLength(1);
    expect((engine as any).audio.src).toContain('blob:part-1');
    expect([...new Uint8Array(await partBlobs[0]!.arrayBuffer())]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
  }
});

function installThrowingAppendMediaSource() {
  const created: Array<{ kind: string; value: unknown }> = [];

  class ThrowingSourceBuffer {
    updating = false;
    private updateListeners = new Set<() => void>();

    addEventListener(type: string, listener: () => void) {
      if (type === 'updateend') this.updateListeners.add(listener);
    }

    removeEventListener(type: string, listener: () => void) {
      if (type === 'updateend') this.updateListeners.delete(listener);
    }

    appendBuffer() {
      throw new Error('non-transient append failure');
    }

    abort() {}
  }

  class ThrowingAppendMediaSource {
    static instances: ThrowingAppendMediaSource[] = [];
    static isTypeSupported() { return true; }
    readyState = 'closed';
    private sourceOpenListeners = new Set<() => void>();

    constructor() {
      ThrowingAppendMediaSource.instances.push(this);
    }

    addEventListener(type: string, listener: () => void) {
      if (type === 'sourceopen') this.sourceOpenListeners.add(listener);
    }

    removeEventListener(type: string, listener: () => void) {
      if (type === 'sourceopen') this.sourceOpenListeners.delete(listener);
    }

    addSourceBuffer() {
      return new ThrowingSourceBuffer();
    }

    endOfStream() {
      this.readyState = 'ended';
    }

    open() {
      this.readyState = 'open';
      for (const listener of [...this.sourceOpenListeners]) listener();
    }
  }

  (window as any).MediaSource = ThrowingAppendMediaSource;
  (window as any).ManagedMediaSource = undefined;
  URL.createObjectURL = (source: any) => {
    const kind = source instanceof Blob ? 'blob' : 'media-source';
    created.push({ kind, value: source });
    return `blob:${kind}-${created.length}`;
  };

  return { ThrowingAppendMediaSource, created };
}

test('an appendBuffer failure before audio_end tears down MSE and finishes in parts with every retained byte', async () => {
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const { ThrowingAppendMediaSource, created } = installThrowingAppendMediaSource();
    const engine = new SpeechEngine();
    engine.startStreamingSession(evenWords(1), 1);
    engine.appendAudioChunk(new Uint8Array([1, 2]));
    ThrowingAppendMediaSource.instances[0]!.open();

    // MediaSource is gone; the session continues in parts with the bytes so far.
    expect(engine.getSnapshot().progressivePlaybackAvailable).toBe(true);
    expect(engine.getSnapshot().playbackReady).toBe(true);
    expect((engine as any).mediaSource).toBeNull();

    engine.appendAudioChunk(new Uint8Array([3, 4]));
    engine.finishStreamingSession();

    expect(engine.getSnapshot().playbackReady).toBe(true);
    expect(created.map(({ kind }) => kind)).toEqual(['media-source', 'blob']);
    expect([
      ...new Uint8Array(await (created[1]!.value as Blob).arrayBuffer()),
    ]).toEqual([1, 2, 3, 4]);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
    console.warn = originalWarn;
  }
});

test('an appendBuffer failure after audio_end immediately switches to a single final part', async () => {
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const { ThrowingAppendMediaSource, created } = installThrowingAppendMediaSource();
    const engine = new SpeechEngine();
    engine.startStreamingSession(evenWords(1), 1);
    engine.appendAudioChunk(new Uint8Array([7, 8, 9]));
    engine.finishStreamingSession();
    ThrowingAppendMediaSource.instances[0]!.open();

    expect(engine.getSnapshot().progressivePlaybackAvailable).toBe(true);
    expect(engine.getSnapshot().playbackReady).toBe(true);
    expect(created.map(({ kind }) => kind)).toEqual(['media-source', 'blob']);
    expect([
      ...new Uint8Array(await (created[1]!.value as Blob).arrayBuffer()),
    ]).toEqual([7, 8, 9]);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
    console.warn = originalWarn;
  }
});

// `audio_end` may arrive before MediaSource emits `sourceopen`. If buffer
// creation then fails, cleanup revokes the source URL; the already-buffered
// complete audio must replace it with one Blob URL, not remain unplayable.
test('delayed source setup failure after audio end installs the completed Blob exactly once', async () => {
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const created: Array<{ kind: string; value: any }> = [];
  const revoked: string[] = [];

  class DelayedFailingMediaSource {
    static instances: DelayedFailingMediaSource[] = [];
    static isTypeSupported() { return true; }
    readyState = 'closed';
    private listeners = new Set<() => void>();

    constructor() {
      DelayedFailingMediaSource.instances.push(this);
    }

    addEventListener(type: string, listener: () => void) {
      if (type === 'sourceopen') this.listeners.add(listener);
    }

    removeEventListener(type: string, listener: () => void) {
      if (type === 'sourceopen') this.listeners.delete(listener);
    }

    addSourceBuffer() {
      throw new Error('MP3 SourceBuffer creation failed');
    }

    endOfStream() {
      this.readyState = 'ended';
    }

    open() {
      this.readyState = 'open';
      for (const listener of [...this.listeners]) listener();
    }
  }

  (window as any).MediaSource = DelayedFailingMediaSource;
  (window as any).ManagedMediaSource = undefined;
  URL.createObjectURL = (source: any) => {
    const kind = source instanceof Blob ? 'blob' : 'media-source';
    created.push({ kind, value: source });
    return `blob:${kind}-${created.length}`;
  };
  URL.revokeObjectURL = (url: string) => revoked.push(url);

  try {
    const engine = new SpeechEngine();
    engine.startStreamingSession(evenWords(1), 1);
    engine.appendAudioChunk(new Uint8Array([4, 5, 6]));
    engine.finishStreamingSession();

    expect(created.map(({ kind }) => kind)).toEqual(['media-source']);

    DelayedFailingMediaSource.instances[0]!.open();
    DelayedFailingMediaSource.instances[0]!.open();

    expect(created.map(({ kind }) => kind)).toEqual(['media-source', 'blob']);
    expect(revoked).toEqual(['blob:media-source-1']);
    expect((engine as any).audio.src).toContain('blob:blob-2');
    expect([
      ...new Uint8Array(await (created[1]!.value as Blob).arrayBuffer()),
    ]).toEqual([4, 5, 6]);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

// Exact Soniox media-time coordinates must survive a later duration event;
// calibrating them would globally stretch the very measurements we requested.
test('authoritative streaming timings are never calibrated to audio duration', () => {
  const engine = new SpeechEngine();
  const exact = [
    { text: 'one', start: 0.25, end: 0.7 },
    { text: 'two', start: 0.9, end: 1.4 },
  ];
  const audio = fakeAudio({
    duration: 4,
    networkState: 1,
    buffered: { length: 1, start: () => 0, end: () => 4 },
  });
  attach(engine, audio, evenWords(2));

  engine.appendWordTimings(exact, 1.4, { authoritative: true });
  (engine as any).calibrateToAudioDuration();

  expect(engine.words).toEqual(exact);
  expect(engine.getSnapshot().authoritativeTimings).toBe(true);
});

// stop() owns every streaming resource. Missing any one of these leaves a
// stale source callback or object URL able to outlive its article.
test('stopping a stream aborts source work, revokes its URL, and ignores later chunks', () => {
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.revokeObjectURL = (url: string) => revoked.push(url);

  const sourceBuffer = {
    updating: true,
    abortCalls: 0,
    abort() { this.abortCalls += 1; },
    addEventListener() {},
    removeEventListener() {},
  };
  const mediaSource = {
    readyState: 'open',
    endOfStream() {},
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    const engine = new SpeechEngine();
    (engine as any).sourceBuffer = sourceBuffer;
    (engine as any).mediaSource = mediaSource;
    (engine as any).ownedObjectUrl = 'blob:streaming-source';
    engine.isStreaming = true;
    engine.appendAudioChunk(new Uint8Array([1]));

    engine.stop();
    engine.appendAudioChunk(new Uint8Array([9]));
    const blob = engine.finishStreamingSession();

    expect(sourceBuffer.abortCalls).toBe(1);
    expect(revoked).toEqual(['blob:streaming-source']);
    expect(blob.size).toBe(0);
    expect((engine as any).mediaSource).toBeNull();
    expect((engine as any).sourceBuffer).toBeNull();
  } finally {
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('muted silences the audio element without touching the timeline', () => {
  const engine = new SpeechEngine();
  engine.loadAudioUrl('/sample_audio.mp3', [
    { text: 'one', start: 0, end: 0.2 },
    { text: 'two', start: 0.2, end: 0.4 },
  ], 0.4);
  const before = engine.getSnapshot();

  engine.muted = true;
  expect(((window as any).__engine as SpeechEngine).muted).toBe(true);
  expect((engine as any).audio.muted).toBe(true);
  expect(engine.getSnapshot().words).toBe(before.words);
  expect(engine.getSnapshot().currentWordIndex).toBe(0);

  engine.muted = false;
  expect((engine as any).audio.muted).toBe(false);
});

test('currentWordIndex tracks seeks so a fallback can resume from the same word', () => {
  const engine = new SpeechEngine();
  engine.loadAudioUrl('/sample_audio.mp3', [
    { text: 'one', start: 0, end: 0.2 },
    { text: 'two', start: 0.2, end: 0.4 },
    { text: 'three', start: 0.4, end: 0.6 },
  ], 0.6);
  engine.seekToWordIndex(2);
  expect(engine.currentWordIndex).toBe(2);
  expect(engine.getSnapshot().currentWordIndex).toBe(2);
});

test('ManagedMediaSource-only browsers get remote playback disabled before attach', () => {
  const originalMediaSource = (window as any).MediaSource;
  const originalManaged = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  class FakeManagedMediaSource {
    static isTypeSupported() { return true; }
    readyState = 'closed';
    addEventListener() {}
    removeEventListener() {}
  }
  (window as any).MediaSource = undefined;
  (window as any).ManagedMediaSource = FakeManagedMediaSource;
  URL.createObjectURL = () => 'blob:managed';
  try {
    const engine = new SpeechEngine();
    const progressive = engine.startStreamingSession([{ text: 'a', start: 0, end: 0.2 }], 0.2);
    expect(progressive).toBe(true);
    expect((engine as any).audio.disableRemotePlayback).toBe(true);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManaged;
    URL.createObjectURL = originalCreateObjectURL;
  }
});

// --- Streaming buffer control ---------------------------------------------

// Stage a progressive session by hand: a fake element whose buffered range
// the test grows, and a fake open SourceBuffer the engine reads it from.
function attachStreaming(engine: SpeechEngine, audio: any, words: { text: string; start: number; end: number }[]) {
  attach(engine, audio, words);
  engine.isPlaying = false;
  (engine as any).mediaSource = { readyState: 'open' };
  (engine as any).sourceBuffer = { buffered: audio.buffered, updating: false };
  engine.isStreaming = true;
  engine.playbackReady = true;
}

function rangeTo(end: number) {
  return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
}

test('play holds for a buffer cushion while the stream is live, then starts on its own', () => {
  const engine = new SpeechEngine();
  let playCalls = 0;
  const audio = fakeAudio({
    paused: true,
    buffered: rangeTo(0.4),
    play() {
      playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
  });
  attachStreaming(engine, audio, evenWords(120));
  engine.rate = 1.5;

  engine.play();
  // Playing from the listener's point of view, but the element is held.
  expect(engine.isPlaying).toBe(true);
  expect(engine.getSnapshot().isBuffering).toBe(true);
  expect(playCalls).toBe(0);

  // One minute at 1.5x needs 90 media seconds.
  audio.buffered = rangeTo(2.0);
  (engine as any).sourceBuffer.buffered = audio.buffered;
  (engine as any).maybeResumeFromBuffering();
  expect(engine.getSnapshot().isBuffering).toBe(true);
  expect(playCalls).toBe(0);

  // ...and now it is.
  audio.buffered = rangeTo(90);
  (engine as any).sourceBuffer.buffered = audio.buffered;
  (engine as any).maybeResumeFromBuffering();
  expect(engine.getSnapshot().isBuffering).toBe(false);
  expect(playCalls).toBe(1);
});

test('a stream that runs low pauses deliberately and refills to the cushion instead of stuttering', () => {
  const engine = new SpeechEngine();
  let playCalls = 0;
  const audio = fakeAudio({
    currentTime: 5.0,
    buffered: rangeTo(10),
    play() {
      playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
  });
  attachStreaming(engine, audio, evenWords(120));
  engine.isPlaying = true;
  (engine as any).hasStartedStreamingPlayback = true;
  engine.rate = 1.0;

  // Plenty ahead: plays normally.
  (engine as any).syncFromAudioTick(0.1);
  expect(audio.paused).toBe(false);
  expect(engine.getSnapshot().isBuffering).toBe(false);

  // The playhead catches the buffer: hold, do not let the browser stall.
  audio.currentTime = 9.7;
  (engine as any).syncFromAudioTick(0.1);
  expect(audio.paused).toBe(true);
  expect(engine.getSnapshot().isBuffering).toBe(true);
  expect(engine.isPlaying).toBe(true);

  // A few frames more is not a reason to resume (that was the stutter).
  audio.buffered = rangeTo(10.3);
  (engine as any).sourceBuffer.buffered = audio.buffered;
  (engine as any).syncFromAudioTick(0.1);
  expect(audio.paused).toBe(true);
  expect(playCalls).toBe(0);

  // Refill fifteen seconds before resuming.
  audio.buffered = rangeTo(25);
  (engine as any).sourceBuffer.buffered = audio.buffered;
  (engine as any).syncFromAudioTick(0.1);
  expect(playCalls).toBe(1);
  expect(audio.paused).toBe(false);
  expect(engine.getSnapshot().isBuffering).toBe(false);
});

test('startup cushion follows playback speed and never exceeds the remaining article', () => {
  const engine = new SpeechEngine();
  const audio = fakeAudio({ paused: true, buffered: rangeTo(6) });
  attachStreaming(engine, audio, evenWords(300));
  engine.rate = 2.0;
  expect(engine.getSnapshot().bufferTargetSeconds).toBe(120);
  engine.rate = 3.5;
  expect(engine.getSnapshot().bufferTargetSeconds).toBe(210);
  engine.duration = 20;
  engine.rate = 1.5;
  expect(engine.getSnapshot().bufferTargetSeconds).toBe(20);
});

test('once the stream is complete nothing is held back, even with a thin buffer', () => {
  const engine = new SpeechEngine();
  let playCalls = 0;
  const audio = fakeAudio({
    paused: true,
    currentTime: 9.8,
    buffered: rangeTo(10),
    play() {
      playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
  });
  attachStreaming(engine, audio, evenWords(10));
  engine.isPlaying = true;
  engine.isBuffering = true;

  engine.isStreaming = false; // audio_end arrived, nothing pending
  (engine as any).maybeResumeFromBuffering();
  expect(playCalls).toBe(1);
  expect(engine.getSnapshot().isBuffering).toBe(false);

  // And pausing clears the buffering state so a later play starts clean.
  engine.pause();
  expect(engine.getSnapshot().isBuffering).toBe(false);
});

// --- Parts mode (no MediaSource) --------------------------------------------

// MPEG-1 Layer III 128 kbps 44.1 kHz: 417-byte frames, 1152/44100 s each.
const PART_FRAME_SECONDS = 1152 / 44100;
function mp3Frames(count: number): Uint8Array {
  const out = new Uint8Array(417 * count);
  for (let i = 0; i < count; i += 1) out.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  return out;
}

function withoutMediaSource<T>(run: () => T): T {
  const originalMediaSource = (window as any).MediaSource;
  const originalManaged = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalFirst = SpeechEngine.FIRST_PART_SECONDS;
  const originalPart = SpeechEngine.PART_SECONDS;
  let urls = 0;
  (window as any).MediaSource = undefined;
  (window as any).ManagedMediaSource = undefined;
  URL.createObjectURL = () => `blob:part-${++urls}`;
  URL.revokeObjectURL = () => {};
  // Tiny parts so the tests need few frames: 0.5 s first, 1 s after.
  SpeechEngine.FIRST_PART_SECONDS = 0.5;
  SpeechEngine.PART_SECONDS = 1;
  const restore = () => {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManaged;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevoke;
    SpeechEngine.FIRST_PART_SECONDS = originalFirst;
    SpeechEngine.PART_SECONDS = originalPart;
  };
  let result: T;
  try {
    result = run();
  } catch (error) {
    restore();
    throw error;
  }
  // An async body keeps the stubs until it settles.
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}

test('without MediaSource, playback becomes possible after the first short part instead of the whole article', () => {
  withoutMediaSource(() => {
    const engine = new SpeechEngine();
    const playCalls: string[] = [];
    const audio = fakeAudio({ paused: true, src: '' });
    audio.play = function () {
      playCalls.push(this.src);
      this.paused = false;
      return Promise.resolve();
    };
    (engine as any).audio = audio;
    engine.startStreamingSession(evenWords(600), 600);
    expect(engine.getSnapshot().progressivePlaybackAvailable).toBe(true);
    // Playable at once (Play holds until audio exists), though nothing has arrived.
    expect(engine.getSnapshot().playbackReady).toBe(true);
    expect((engine as any).parts).toHaveLength(0);

    // Listener presses Play before any audio: held, not refused.
    engine.play();
    expect(engine.isPlaying).toBe(true);
    expect(engine.getSnapshot().isBuffering).toBe(true);

    // 10 frames (~0.26 s) is not yet a first part...
    engine.appendAudioChunk(mp3Frames(10));
    expect((engine as any).parts).toHaveLength(0);
    expect(playCalls).toEqual([]);
    // ...30 frames (~0.78 s) is: the first part is cut, loaded, and -- since
    // the whole stream may still be slower than playback -- held for the
    // buffer cushion before the element starts.
    engine.appendAudioChunk(mp3Frames(20));
    expect((engine as any).parts).toHaveLength(1);
    expect(audio.src).toBe('blob:part-1');
    expect((engine as any).parts[0].duration).toBeCloseTo(30 * PART_FRAME_SECONDS, 6);
    expect(engine.isPlaying).toBe(true);
  });
});

test('parts play back to back on one continuous timeline, and hold at the end of what has arrived', async () => {
  await withoutMediaSource(async () => {
    const engine = new SpeechEngine();
    const audio = fakeAudio({ paused: true, src: '' });
    (engine as any).audio = audio;
    engine.rate = 0.8;
    engine.startStreamingSession(evenWords(600), 600);
    engine.appendAudioChunk(mp3Frames(1000)); // part 0 (~26 s)
    engine.appendAudioChunk(mp3Frames(1000)); // part 1 (~26 s)
    expect((engine as any).parts).toHaveLength(2);
    const part0 = (engine as any).parts[0].duration as number;

    engine.play();
    await Promise.resolve(); // play() commits `isPlaying` once the element's play() resolves
    expect(audio.src).toBe('blob:part-1');
    expect(engine.getSnapshot().isBuffering).toBe(false);
    expect(audio.paused).toBe(false);
    expect(engine.isPlaying).toBe(true);

    // Part 0 ends: part 1 loads immediately, timeline continues from part0's end.
    audio.currentTime = 0.4;
    (engine as any).onPartEnded();
    expect(audio.src).toBe('blob:part-2');
    expect(engine.isPlaying).toBe(true);
    audio.currentTime = 0.25;
    (engine as any).syncFromAudioTick(0.1);
    expect(engine.currentTime).toBeCloseTo(part0 + 0.25, 5);

    // Part 1 ends with nothing further yet: hold (buffering), do not end.
    (engine as any).onPartEnded();
    expect(engine.isPlaying).toBe(true);
    expect(engine.getSnapshot().isBuffering).toBe(true);

    // The stream finishes with a short tail: it becomes the final part, playback resumes there.
    engine.appendAudioChunk(mp3Frames(5));
    engine.finishStreamingSession();
    expect((engine as any).parts).toHaveLength(3);
    expect(audio.src).toBe('blob:part-3');
    expect(engine.getSnapshot().isBuffering).toBe(false);

    // And the last part ending is the real end.
    (engine as any).onPartEnded();
    expect(engine.isPlaying).toBe(false);
    expect(engine.getSnapshot().progress).toBe(100);
  });
});

test('seeking across parts loads the right part at the right offset', () => {
  withoutMediaSource(() => {
    const engine = new SpeechEngine();
    const audio = fakeAudio({ paused: true, src: '' });
    (engine as any).audio = audio;
    engine.startStreamingSession(evenWords(600), 600);
    engine.appendAudioChunk(mp3Frames(30));
    engine.appendAudioChunk(mp3Frames(50));
    engine.finishStreamingSession();
    const [p0, p1] = (engine as any).parts as Array<{ start: number; duration: number }>;

    // A word inside part 1.
    const target = p1!.start + 0.5;
    engine.seekToWordIndex(Math.floor(target)); // evenWords: word i starts at i seconds -> index 0 or 1
    // seekToWordIndex uses word starts; drive seekAudioTo directly for a precise check.
    (engine as any).seekAudioTo(target);
    expect(audio.src).toBe('blob:part-2');
    expect(audio.currentTime).toBeCloseTo(0.5, 5);

    // Back into part 0.
    (engine as any).seekAudioTo(0.2);
    expect(audio.src).toBe('blob:part-1');
    expect(audio.currentTime).toBeCloseTo(0.2, 5);
    expect(p0!.start).toBe(0);
  });
});

test('long articles wait for a minute of listening before starting, then resume automatically', () => {
  const engine = new SpeechEngine();
  const audio = fakeAudio({ paused: true, buffered: rangeTo(4) });
  attachStreaming(engine, audio, evenWords(600));
  engine.rate = 1.5;
  engine.play();
  expect(audio.paused).toBe(true);
  expect(engine.isBuffering).toBe(true);
  audio.buffered = rangeTo(90);
  (engine as any).sourceBuffer.buffered = audio.buffered;
  (engine as any).maybeResumeFromBuffering();
  expect(audio.paused).toBe(false);
  expect(engine.isBuffering).toBe(false);
  engine.stop();
});

test('resuming beyond downloaded parts waits for that position instead of playing from the beginning', () => {
  withoutMediaSource(() => {
    const engine = new SpeechEngine();
    const audio = fakeAudio({ paused: true });
    (engine as any).audio = audio;
    engine.startStreamingSession(evenWords(600), 600);
    engine.seekToWordIndex(90);
    expect(engine.currentTime).toBe(90);
    engine.appendAudioChunk(mp3Frames(1000));
    expect(engine.getSnapshot().canStartPlayback).toBe(false);
    engine.appendAudioChunk(mp3Frames(7000));
    expect((engine as any).pendingSeekTime).toBeNull();
    expect((engine as any).partOffset + audio.currentTime).toBeCloseTo(90, 5);
    expect(engine.getSnapshot().canStartPlayback).toBe(true);
    engine.stop();
  });
});
