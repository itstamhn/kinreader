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
    buffered: { length: 1, end: () => 20 },
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
    buffered: { length: 1, end: () => 4 },
    networkState: 2, // NETWORK_LOADING -- still pulling bytes
  });
  attach(engine, audio, evenWords(10));

  (engine as any).calibrateToAudioDuration();

  expect(engine.words[9]!.end).toBe(10); // untouched
});
