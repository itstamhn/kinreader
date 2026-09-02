import { test, expect } from 'bun:test';
import { generateTrackWithSoniox } from './generateTrack';
import type { OpenParallelSonioxStreamOptions } from './parallelSoniox';

function timestampsFor(text: string, start = 0.1, step = 0.05) {
  const characters = [...text];
  return {
    characters,
    starts: characters.map((_, index) => Number((start + index * step).toFixed(3))),
    ends: characters.map((_, index) => Number((start + (index + 1) * step).toFixed(3))),
  };
}

test('collects audio and exact word timings for the whole text and resolves on termination', async () => {
  let captured: OpenParallelSonioxStreamOptions | null = null;
  const promise = generateTrackWithSoniox({
    apiKey: 'server-key',
    text: '  Hello there world.  ',
    voice: 'Adrian',
    openStream: (options) => {
      captured = options;
      return { cancel() {} };
    },
  });

  const handlers = captured!.handlers;
  expect(captured!.text).toBe('Hello there world.');
  handlers.onAudio(new Uint8Array([1, 2]));
  handlers.onTimestamps(timestampsFor('Hello th'));
  handlers.onAudio(new Uint8Array([3]));
  handlers.onTimestamps(timestampsFor('ere world.', 0.1 + 8 * 0.05));
  handlers.onDone();
  handlers.onTerminated?.();

  const track = await promise;
  expect([...track.audio]).toEqual([1, 2, 3]);
  expect(track.words.map((w) => w.text)).toEqual(['Hello', 'there', 'world.']);
  expect(track.duration).toBe(track.words.at(-1)!.end);
});

test('a transport error rejects and cancels; an incomplete character stream rejects too', async () => {
  let captured: OpenParallelSonioxStreamOptions | null = null;
  let cancelled = 0;
  const failing = generateTrackWithSoniox({
    apiKey: 'k',
    text: 'Some text',
    voice: 'Adrian',
    openStream: (options) => {
      captured = options;
      return { cancel() { cancelled += 1; } };
    },
  });
  captured!.handlers.onError(new Error('socket refused'));
  await expect(failing).rejects.toThrow('socket refused');
  expect(cancelled).toBe(1);

  const mismatched = generateTrackWithSoniox({
    apiKey: 'k',
    text: 'Some text',
    voice: 'Adrian',
    openStream: (options) => {
      captured = options;
      return { cancel() {} };
    },
  });
  captured!.handlers.onTimestamps(timestampsFor('Some'));
  captured!.handlers.onTerminated?.();
  await expect(mismatched).rejects.toThrow(/incomplete/i);
});

test('gives up after the timeout', async () => {
  const promise = generateTrackWithSoniox({
    apiKey: 'k',
    text: 'Slow text',
    voice: 'Adrian',
    timeoutMs: 20,
    openStream: () => ({ cancel() {} }),
  });
  await expect(promise).rejects.toThrow(/timed out/);
});
