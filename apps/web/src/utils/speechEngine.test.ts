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
