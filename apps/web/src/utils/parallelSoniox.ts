import {
  openSonioxStream,
  type OpenSonioxStreamOptions,
  type SonioxStreamHandlers,
  type SonioxTimestamps,
} from './sonioxStream';
import { concatBytes, mp3DurationSeconds } from './mp3Duration';

// One Soniox real-time session produces audio at roughly the pace it is
// spoken. The reader plays at 1.5x by default, so a single stream can never
// get ahead of the listener: the buffer control in speechEngine.ts turns the
// resulting stutter into pauses, but it cannot make audio arrive faster. This
// transport does. It splits the article into a few contiguous segments at
// sentence boundaries, synthesises them over concurrent sessions, and
// re-serialises the results so the engine sees exactly one stream: audio
// chunks in article order, character timestamps shifted onto one timeline.
//
// Segment N+1's audio is held until segment N has fully arrived (MP3 frames
// have to be appended in order), and its timestamps are shifted by the exact
// decoded duration of everything before it -- measured from the MP3 frame
// headers (mp3Duration.ts), not from the last spoken character, because
// Soniox leaves trailing silence after the final word.
//
// With three or four sessions the article arrives several times faster than
// real time even at 3.5x playback, which is what lets the buffer control's
// cushion stay small and playback run without refills.

export const MAX_PARALLEL_SEGMENTS = 4;
// Below this a second session costs more in setup than it saves.
export const MIN_CHARS_PER_SEGMENT = 1200;
const SONIOX_MESSAGE_CHARS = 450;

export function chooseSegmentCount(text: string): number {
  return Math.max(1, Math.min(MAX_PARALLEL_SEGMENTS, Math.round(text.length / MIN_CHARS_PER_SEGMENT)));
}

// Contiguous, verbatim slices whose concatenation is exactly `text` -- the
// word-timing accumulator checks every returned character against the
// article, so nothing may be trimmed or re-inserted. Cuts land right after a
// sentence end plus its whitespace when one is near the ideal point, or after
// the nearest whitespace run otherwise, so every segment starts on a word.
export function splitIntoSegments(text: string, count: number): string[] {
  if (count <= 1 || text.length === 0) return [text];
  const target = text.length / count;
  const window = Math.max(40, Math.floor(target * 0.4));

  const cutAfterWhitespaceRun = (position: number) => {
    let end = position;
    while (end < text.length && /\s/.test(text[end]!)) end += 1;
    return end;
  };

  const boundaries: number[] = [];
  let previous = 0;
  for (let k = 1; k < count; k += 1) {
    const ideal = Math.round(k * target);
    const from = Math.max(previous + 1, ideal - window);
    const to = Math.min(text.length - 1, ideal + window);
    if (from >= to) break;

    // Prefer the sentence end closest to the ideal point.
    let best: number | null = null;
    let bestDistance = Infinity;
    const sentenceEnd = /[.!?]["'”’)\]]*\s+/g;
    sentenceEnd.lastIndex = from;
    let match: RegExpExecArray | null;
    while ((match = sentenceEnd.exec(text)) !== null) {
      const cut = match.index + match[0].length;
      if (match.index > to) break;
      const distance = Math.abs(cut - ideal);
      if (distance < bestDistance) {
        best = cut;
        bestDistance = distance;
      }
    }

    // Otherwise the nearest whitespace run to the ideal point.
    if (best === null) {
      let left = ideal;
      while (left > from && !/\s/.test(text[left]!)) left -= 1;
      let right = ideal;
      while (right < to && !/\s/.test(text[right]!)) right += 1;
      const candidate = /\s/.test(text[left]!) && ideal - left <= right - ideal ? left : /\s/.test(text[right]!) ? right : -1;
      if (candidate === -1) continue;
      let start = candidate;
      while (start > previous && /\s/.test(text[start - 1]!)) start -= 1;
      best = cutAfterWhitespaceRun(start);
    }

    if (best <= previous || best >= text.length) continue;
    boundaries.push(best);
    previous = best;
  }

  const segments: string[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    segments.push(text.slice(start, boundary));
    start = boundary;
  }
  segments.push(text.slice(start));
  return segments.filter((segment) => segment.trim().length > 0);
}

// Verbatim (untrimmed) message chunks for one segment.
function chunkVerbatim(segment: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < segment.length; start += SONIOX_MESSAGE_CHARS) {
    chunks.push(segment.slice(start, start + SONIOX_MESSAGE_CHARS));
  }
  return chunks;
}

type BufferedEvent = { kind: 'audio'; chunk: Uint8Array } | { kind: 'timestamps'; batch: SonioxTimestamps };

interface SegmentState {
  text: string;
  events: BufferedEvent[];
  audio: Uint8Array[];
  lastTimestampEnd: number;
  done: boolean;
  terminated: boolean;
  failed: Error | null;
  attempts: number;
  handle: { cancel(): void } | null;
}

export interface OpenParallelSonioxStreamOptions extends OpenSonioxStreamOptions {
  segments?: number;
  /** Injectable for tests; defaults to the real WebSocket transport. */
  openStream?: (options: OpenSonioxStreamOptions) => { cancel(): void };
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

export function openParallelSonioxStream(options: OpenParallelSonioxStreamOptions): { cancel(): void } {
  const openStream = options.openStream ?? openSonioxStream;
  const count = options.segments ?? chooseSegmentCount(options.text);
  const texts = splitIntoSegments(options.text, count);
  if (texts.length <= 1) return openStream(options);

  const handlers = options.handlers;
  const segments: SegmentState[] = texts.map((text) => ({
    text,
    events: [],
    audio: [],
    lastTimestampEnd: 0,
    done: false,
    terminated: false,
    failed: null,
    attempts: 0,
    handle: null,
  }));

  let active = 0;
  let offset = 0;
  let lastForwardedEnd = 0;
  let cancelled = false;
  let finished = false;
  let failed = false;

  const isLast = (index: number) => index === segments.length - 1;

  const shift = (batch: SonioxTimestamps): SonioxTimestamps => {
    const shifted = {
      characters: batch.characters,
      starts: batch.starts.map((start) => round3(start + offset)),
      ends: batch.ends.map((end) => round3(end + offset)),
    };
    for (const end of shifted.ends) if (end > lastForwardedEnd) lastForwardedEnd = end;
    return shifted;
  };

  const fail = (error: Error) => {
    if (cancelled || finished || failed) return;
    failed = true;
    for (const segment of segments) segment.handle?.cancel();
    handlers.onError(error);
  };

  const forward = (event: BufferedEvent) => {
    if (event.kind === 'audio') handlers.onAudio(event.chunk);
    else handlers.onTimestamps(shift(event.batch));
  };

  // Move the "live" pointer past every segment that has fully arrived,
  // flushing each newly active segment's buffered events in arrival order.
  const advance = () => {
    while (!cancelled && !failed && !finished) {
      const current = segments[active]!;
      if (!current.terminated) return;

      // The next segment's timeline starts where this one's audio ends --
      // never before the last word already shown, so the merged timestamps
      // stay monotonic even if a decoded duration comes up a hair short.
      const decoded = mp3DurationSeconds(concatBytes(current.audio));
      const measured = decoded > 0 ? decoded : current.lastTimestampEnd;
      offset = Math.max(offset + measured, lastForwardedEnd);

      active += 1;
      if (active >= segments.length) {
        finished = true;
        handlers.onTerminated?.();
        return;
      }

      const next = segments[active]!;
      if (next.failed) {
        // It failed while waiting (a concurrency limit, most likely). Now that
        // it is the only thing we need, run it again on its own.
        next.failed = null;
        next.events = [];
        next.audio = [];
        next.handle?.cancel();
        if (next.attempts >= 2) {
          fail(new Error('Soniox segment failed twice'));
          return;
        }
        start(active);
        return;
      }
      for (const event of next.events) forward(event);
      next.events = [];
      if (next.done && isLast(active)) handlers.onDone();
      // If it already terminated while buffered, the loop advances again.
    }
  };

  const start = (index: number) => {
    const segment = segments[index]!;
    segment.attempts += 1;
    const segmentHandlers: SonioxStreamHandlers = {
      onAudio: (chunk) => {
        if (cancelled || failed) return;
        segment.audio.push(chunk);
        if (index === active) handlers.onAudio(chunk);
        else segment.events.push({ kind: 'audio', chunk });
      },
      onTimestamps: (batch) => {
        if (cancelled || failed) return;
        for (const end of batch.ends) if (end > segment.lastTimestampEnd) segment.lastTimestampEnd = end;
        if (index === active) handlers.onTimestamps(shift(batch));
        else segment.events.push({ kind: 'timestamps', batch });
      },
      onDone: () => {
        if (cancelled || failed) return;
        segment.done = true;
        if (index === active && isLast(index)) handlers.onDone();
      },
      onTerminated: () => {
        if (cancelled || failed) return;
        segment.terminated = true;
        if (index === active) advance();
      },
      onError: (error) => {
        if (cancelled || failed) return;
        if (index === active) {
          fail(error);
          return;
        }
        segment.failed = error;
        segment.events = [];
        segment.audio = [];
      },
    };
    segment.handle = openStream({
      apiKey: options.apiKey,
      text: segment.text,
      textChunks: chunkVerbatim(segment.text),
      voice: options.voice,
      handlers: segmentHandlers,
    });
  };

  for (let index = 0; index < segments.length; index += 1) start(index);

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const segment of segments) segment.handle?.cancel();
    },
  };
}
