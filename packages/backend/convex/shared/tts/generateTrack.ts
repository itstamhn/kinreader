import { openParallelSonioxStream, type OpenParallelSonioxStreamOptions } from './parallelSoniox';
import type { OpenSonioxStreamOptions, SonioxSocketConstructor } from './sonioxStream';
import { concatBytes } from './mp3Duration';
import { createWordTimingAccumulator, type WordTiming } from './wordTimings';

// Synthesises a whole article to a finished MP3 plus exact word timings, using
// the same parallel Soniox client the reader streams with. The reader uses
// this path indirectly (it feeds the engine as chunks arrive); the Convex
// pre-generation action uses it directly so an article added to the queue is
// already a cached, instantly playable track by the time it is opened.

export interface GeneratedTrack {
  audio: Uint8Array;
  words: WordTiming[];
  duration: number;
}

export interface GenerateTrackOptions {
  apiKey: string;
  text: string;
  voice: string;
  segments?: number;
  /** Fail if the whole synthesis takes longer than this. */
  timeoutMs?: number;
  webSocket?: SonioxSocketConstructor;
  /** Injectable for tests; defaults to the parallel WebSocket transport. */
  openStream?: (options: OpenParallelSonioxStreamOptions) => { cancel(): void };
}

// Under Convex's 10-minute action limit, so a stuck synthesis is recorded as
// failed rather than the action being killed with the job left "running".
const DEFAULT_TIMEOUT_MS = 7 * 60 * 1000;

export function generateTrackWithSoniox(options: GenerateTrackOptions): Promise<GeneratedTrack> {
  const text = options.text.trim();
  if (!text) return Promise.reject(new Error('Cannot synthesise empty text'));
  const open = options.openStream ?? openParallelSonioxStream;

  return new Promise<GeneratedTrack>((resolve, reject) => {
    const accumulator = createWordTimingAccumulator(text);
    const chunks: Uint8Array[] = [];
    const words: WordTiming[] = [];
    let settled = false;
    let handle: { cancel(): void } | null = null;

    const timer = setTimeout(() => {
      finish(new Error(`Soniox synthesis timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const finish = (error: Error | null, track?: GeneratedTrack) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        handle?.cancel();
        reject(error);
      } else {
        resolve(track!);
      }
    };

    const streamOptions: OpenParallelSonioxStreamOptions & OpenSonioxStreamOptions = {
      apiKey: options.apiKey,
      text,
      voice: options.voice,
      ...(options.segments !== undefined ? { segments: options.segments } : {}),
      ...(options.webSocket ? { webSocket: options.webSocket } : {}),
      handlers: {
        onAudio: (chunk) => {
          if (!settled) chunks.push(chunk);
        },
        onTimestamps: (batch) => {
          if (settled) return;
          try {
            words.push(...accumulator.append(batch));
          } catch (error) {
            finish(error instanceof Error ? error : new Error('Invalid Soniox timestamps'));
          }
        },
        onDone: () => {},
        onTerminated: () => {
          if (settled) return;
          try {
            words.push(...accumulator.flush());
          } catch (error) {
            finish(error instanceof Error ? error : new Error('Incomplete Soniox timestamps'));
            return;
          }
          const audio = concatBytes(chunks);
          const duration = words.at(-1)?.end ?? 0;
          if (audio.byteLength === 0 || words.length === 0 || duration <= 0) {
            finish(new Error('Soniox returned no audio'));
            return;
          }
          finish(null, { audio, words, duration });
        },
        onError: (error) => finish(error),
      },
    };

    handle = open(streamOptions);
  });
}
