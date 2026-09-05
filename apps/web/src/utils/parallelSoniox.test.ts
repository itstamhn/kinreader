import { test, expect } from 'bun:test';
import {
  chooseSegmentCount,
  openParallelSonioxStream,
  splitIntoSegments,
} from './parallelSoniox';
import type { OpenSonioxStreamOptions, SonioxStreamHandlers } from './sonioxStream';
import { createWordTimingAccumulator } from './wordTimings';

// MPEG-1 Layer III 128 kbps 44.1 kHz frame: 417 bytes, 1152/44100 s.
const FRAME_SECONDS = 1152 / 44100;
function frames(count: number): Uint8Array {
  const out = new Uint8Array(417 * count);
  for (let i = 0; i < count; i += 1) out.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  return out;
}

function timestampsFor(text: string, start: number, step = 0.05) {
  const characters = [...text];
  return {
    characters,
    starts: characters.map((_, index) => Number((start + index * step).toFixed(3))),
    ends: characters.map((_, index) => Number((start + (index + 1) * step).toFixed(3))),
  };
}

// A fake per-segment transport the test drives by hand.
function fakeOpener() {
  const streams: Array<{ options: OpenSonioxStreamOptions; handlers: SonioxStreamHandlers; cancelled: number }> = [];
  return {
    streams,
    open(options: OpenSonioxStreamOptions) {
      const stream = { options, handlers: options.handlers, cancelled: 0 };
      streams.push(stream);
      return { cancel: () => { stream.cancelled += 1; } };
    },
  };
}

function recorder() {
  const events: Array<
    | { kind: 'audio'; bytes: number }
    | { kind: 'timestamps'; text: string; firstStart: number; lastEnd: number }
    | { kind: 'done' }
    | { kind: 'terminated' }
    | { kind: 'error'; message: string }
  > = [];
  const handlers: SonioxStreamHandlers = {
    onAudio: (chunk) => events.push({ kind: 'audio', bytes: chunk.byteLength }),
    onTimestamps: (batch) =>
      events.push({
        kind: 'timestamps',
        text: batch.characters.join(''),
        firstStart: batch.starts[0]!,
        lastEnd: batch.ends.at(-1)!,
      }),
    onDone: () => events.push({ kind: 'done' }),
    onTerminated: () => events.push({ kind: 'terminated' }),
    onError: (error) => events.push({ kind: 'error', message: error.message }),
  };
  return { events, handlers };
}

test('segments are verbatim slices that cut after sentence ends and rejoin to the article', () => {
  const text =
    'First sentence here. Second one follows! Third asks a question? Fourth keeps going. Fifth ends it.';
  const segments = splitIntoSegments(text, 3);
  expect(segments.join('')).toBe(text);
  expect(segments.length).toBeGreaterThan(1);
  for (const segment of segments) {
    expect(segment.trim().length).toBeGreaterThan(0);
    // Every segment after the first starts on a word, so its stream speaks
    // from the first character.
    if (segment !== segments[0]) expect(/^\S/.test(segment)).toBe(true);
  }
  // Cuts land after sentence punctuation plus whitespace.
  for (const segment of segments.slice(0, -1)) expect(/[.!?]\s+$/.test(segment)).toBe(true);
});

test('text with no sentence ends still splits on whitespace, and short text does not split', () => {
  const words = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
  const segments = splitIntoSegments(words, 4);
  expect(segments.join('')).toBe(words);
  expect(segments.length).toBe(4);
  expect(splitIntoSegments('too short to bother', 3).join('')).toBe('too short to bother');
  expect(chooseSegmentCount('x'.repeat(500))).toBe(1);
  expect(chooseSegmentCount('x'.repeat(2500))).toBe(6);
  expect(chooseSegmentCount('x'.repeat(20000))).toBe(50);
  // Very long text gets more segments so no single session carries too much.
  expect(chooseSegmentCount('x'.repeat(45000))).toBe(113);
});

test('a long article runs as waves: at most maxConcurrent sessions open, the rest start as slots free', () => {
  const text = Array.from({ length: 6 }, (_, i) => `Segment ${i} says a few words here.`).join(' ');
  const opener = fakeOpener();
  const { events, handlers } = recorder();
  openParallelSonioxStream({
    apiKey: 'k',
    text,
    voice: 'Adrian',
    handlers,
    segments: 6,
    maxConcurrent: 2,
    openStream: opener.open,
  });
  expect(opener.streams).toHaveLength(2);

  // Segment 1 (waiting, not live) finishes: a slot frees, segment 2 starts.
  opener.streams[1]!.handlers.onAudio(frames(5));
  opener.streams[1]!.handlers.onTimestamps(timestampsFor(opener.streams[1]!.options.text, 0.1));
  opener.streams[1]!.handlers.onDone();
  opener.streams[1]!.handlers.onTerminated?.();
  expect(opener.streams).toHaveLength(3);
  expect(events).toEqual([]);

  // The live segment 0 finishes: its slot frees (segment 3 starts) and the
  // buffered segment 1 replays; segment 2 is now live.
  opener.streams[0]!.handlers.onAudio(frames(5));
  opener.streams[0]!.handlers.onTimestamps(timestampsFor(opener.streams[0]!.options.text, 0.1));
  opener.streams[0]!.handlers.onDone();
  opener.streams[0]!.handlers.onTerminated?.();
  expect(opener.streams).toHaveLength(4);
  expect(events.filter((e) => e.kind === 'timestamps').map((e: any) => e.text)).toEqual([
    opener.streams[0]!.options.text,
    opener.streams[1]!.options.text,
  ]);

  // Drain the rest in order; the pool never exceeds two open sessions.
  for (let i = 2; i < 6; i += 1) {
    const s = opener.streams[i]!;
    s.handlers.onAudio(frames(5));
    s.handlers.onTimestamps(timestampsFor(s.options.text, 0.1));
    s.handlers.onDone();
    s.handlers.onTerminated?.();
    expect(opener.streams.length).toBeLessThanOrEqual(6);
  }
  expect(opener.streams).toHaveLength(6);
  expect(opener.streams.map((s) => s.options.text).join('')).toBe(text);
  expect(events.at(-2)).toEqual({ kind: 'done' });
  expect(events.at(-1)).toEqual({ kind: 'terminated' });
});

test('a single segment is a plain pass-through to the underlying transport', () => {
  const opener = fakeOpener();
  const { handlers } = recorder();
  openParallelSonioxStream({ apiKey: 'k', text: 'short text', voice: 'Adrian', handlers, segments: 1, openStream: opener.open });
  expect(opener.streams).toHaveLength(1);
  expect(opener.streams[0]!.handlers).toBe(handlers);
});

test('later segments are held, then replayed in order with timestamps shifted by the decoded audio length', () => {
  const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota.';
  const opener = fakeOpener();
  const { events, handlers } = recorder();
  const stream = openParallelSonioxStream({ apiKey: 'k', text, voice: 'Adrian', handlers, segments: 3, openStream: opener.open });

  expect(opener.streams).toHaveLength(3);
  const [s0, s1, s2] = opener.streams as [typeof opener.streams[0], typeof opener.streams[0], typeof opener.streams[0]];
  const segTexts = opener.streams.map((s) => s.options.text);
  expect(segTexts.join('')).toBe(text);
  // Segments are sent verbatim, whitespace included.
  expect(s0.options.textChunks).toEqual([segTexts[0]!]);

  // Segment 1 finishes first (it was short) -- everything it produces is held.
  s1.handlers.onAudio(frames(50));
  s1.handlers.onTimestamps(timestampsFor(segTexts[1]!, 0.1));
  s1.handlers.onDone();
  s1.handlers.onTerminated?.();
  expect(events).toEqual([]);

  // Segment 0 streams live, unshifted.
  s0.handlers.onAudio(frames(40));
  s0.handlers.onTimestamps(timestampsFor(segTexts[0]!, 0.1));
  expect(events[0]).toEqual({ kind: 'audio', bytes: 417 * 40 });
  expect(events[1]).toMatchObject({ kind: 'timestamps', text: segTexts[0], firstStart: 0.1 });
  const seg0LastEnd = (events[1] as any).lastEnd as number;

  // Segment 0 completes with 10 more frames of trailing silence: 50 in total.
  s0.handlers.onAudio(frames(10));
  s0.handlers.onDone();
  s0.handlers.onTerminated?.();

  // Segment 1's held events replay immediately, shifted by the 50 decoded
  // frames -- more than the last spoken character's end, as trailing silence is.
  const offset0 = 50 * FRAME_SECONDS;
  expect(offset0).toBeGreaterThan(seg0LastEnd);
  expect(events[3]).toEqual({ kind: 'audio', bytes: 417 * 50 });
  expect(events[4]).toMatchObject({ kind: 'timestamps', text: segTexts[1] });
  expect((events[4] as any).firstStart).toBeCloseTo(0.1 + offset0, 3);
  // No whole-stream done yet: segment 1 was not the last one.
  expect(events.some((e) => e.kind === 'done')).toBe(false);

  // Segment 2 is now live; its timestamps shift by both earlier durations.
  s2.handlers.onAudio(frames(1));
  s2.handlers.onTimestamps(timestampsFor(segTexts[2]!, 0.1));
  s2.handlers.onDone();
  s2.handlers.onTerminated?.();
  const offset1 = offset0 + 50 * FRAME_SECONDS;
  const seg2Timestamps = events.find((e) => e.kind === 'timestamps' && e.text === segTexts[2]) as any;
  expect(seg2Timestamps.firstStart).toBeCloseTo(0.1 + offset1, 3);
  expect(events.at(-2)).toEqual({ kind: 'done' });
  expect(events.at(-1)).toEqual({ kind: 'terminated' });
  expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);

  stream.cancel();
  expect(opener.streams.every((s) => s.cancelled === 1)).toBe(true);
});

test('the merged character stream satisfies the word-timing accumulator exactly', () => {
  const text = 'One two three. Four five six. Seven eight nine.';
  const opener = fakeOpener();
  const accumulator = createWordTimingAccumulator(text);
  const words: Array<{ text: string; start: number; end: number }> = [];
  const handlers: SonioxStreamHandlers = {
    onAudio: () => {},
    onTimestamps: (batch) => words.push(...accumulator.append(batch)),
    onDone: () => {},
    onTerminated: () => words.push(...accumulator.flush()),
    onError: (error) => { throw error; },
  };
  openParallelSonioxStream({ apiKey: 'k', text, voice: 'Adrian', handlers, segments: 3, openStream: opener.open });

  // Deliver out of order to prove buffering keeps the article order.
  for (const index of [2, 0, 1]) {
    const s = opener.streams[index]!;
    s.handlers.onAudio(frames(5));
    s.handlers.onTimestamps(timestampsFor(s.options.text, 0.2));
    s.handlers.onDone();
    s.handlers.onTerminated?.();
  }

  expect(words.map((w) => w.text)).toEqual(text.split(/\s+/));
  for (let i = 1; i < words.length; i += 1) {
    expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.end - 1e-9);
  }
});

test('a segment that fails while waiting is retried alone when its turn comes; a live failure propagates', () => {
  const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota.';
  const opener = fakeOpener();
  const { events, handlers } = recorder();
  openParallelSonioxStream({ apiKey: 'k', text, voice: 'Adrian', handlers, segments: 3, openStream: opener.open });
  const [s0, s1] = opener.streams as [typeof opener.streams[0], typeof opener.streams[0]];

  // Segment 1 is rejected up front (e.g. a concurrency limit). Nothing leaks.
  s1.handlers.onError(new Error('too many sessions'));
  expect(events).toEqual([]);

  s0.handlers.onAudio(frames(2));
  s0.handlers.onTimestamps(timestampsFor(s0.options.text, 0.1));
  s0.handlers.onDone();
  s0.handlers.onTerminated?.();

  // A fresh session for segment 1 was opened on the same text.
  expect(opener.streams).toHaveLength(4);
  const retry = opener.streams[3]!;
  expect(retry.options.text).toBe(s1.options.text);

  // A failure while live is the whole stream's failure.
  retry.handlers.onError(new Error('socket dropped'));
  expect(events.at(-1)).toEqual({ kind: 'error', message: 'socket dropped' });
  expect(opener.streams.every((s) => s.cancelled >= 1)).toBe(true);
});
