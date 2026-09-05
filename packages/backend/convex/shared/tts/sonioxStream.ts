import { splitTextIntoSonioxChunks } from '../soniox';

export interface SonioxTimestamps {
  characters: string[];
  starts: number[];
  ends: number[];
}

export interface SonioxStreamHandlers {
  onAudio(chunk: Uint8Array): void;
  onTimestamps(timestamps: SonioxTimestamps): void;
  onDone(): void;
  /** All trailing timestamp messages have arrived and the session is closed. */
  onTerminated?(): void;
  onError(error: Error): void;
}

export class SonioxProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SonioxProtocolError';
  }
}

/** A session key has expired and may safely be re-minted before retrying. */
export class SonioxTemporaryKeyExpiredError extends Error {
  readonly errorType = 'temp_api_key_session_expired';

  constructor() {
    super('The Soniox temporary API key session expired');
    this.name = 'SonioxTemporaryKeyExpiredError';
  }
}

// The subset of the WebSocket surface this client uses. Browser `WebSocket`
// and the `ws` package (Convex Node actions) both satisfy it, so the same
// code streams in the reader and pre-generates on the server.
export interface SonioxSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SonioxSocketConstructor = new (url: string) => SonioxSocket;

export interface OpenSonioxStreamOptions {
  apiKey: string;
  text: string;
  voice: string;
  handlers: SonioxStreamHandlers;
  /** Socket implementation; defaults to the global `WebSocket`. */
  webSocket?: SonioxSocketConstructor;
  /**
   * Exact messages to send instead of splitting (and trimming) `text`. The
   * parallel transport uses this so a segment that begins or ends with
   * whitespace is sent verbatim and its characters still line up with the
   * article.
   */
  textChunks?: string[];
}

const SONIOX_WEBSOCKET_URL = 'wss://tts-rt.soniox.com/tts-websocket';

function createStreamId(): string {
  return crypto.randomUUID();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normaliseTimestamps(value: unknown): SonioxTimestamps {
  if (!isRecord(value)) throw new SonioxProtocolError('Soniox sent malformed timestamps');

  const characters = value.characters;
  const starts = value.character_start_times_seconds;
  const ends = value.character_end_times_seconds;
  if (
    !Array.isArray(characters) ||
    !characters.every((character) => typeof character === 'string') ||
    !Array.isArray(starts) ||
    !starts.every((start) => typeof start === 'number' && Number.isFinite(start)) ||
    !Array.isArray(ends) ||
    !ends.every((end) => typeof end === 'number' && Number.isFinite(end)) ||
    characters.length !== starts.length ||
    characters.length !== ends.length
  ) {
    throw new SonioxProtocolError('Soniox sent malformed timestamps');
  }

  return { characters, starts, ends };
}

function decodeAudio(base64: string): Uint8Array {
  try {
    const binary = atob(base64);
    const audio = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      audio[index] = binary.charCodeAt(index);
    }
    return audio;
  } catch {
    throw new SonioxProtocolError('Soniox sent malformed base64 audio');
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new SonioxProtocolError(fallback);
}

/**
 * Opens a browser-direct Soniox real-time stream. Audio and timestamps are
 * deliberately independent callbacks because Soniox does not co-locate them
 * in every server message.
 */
function decodeTextFrame(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  throw new SonioxProtocolError('Soniox sent a non-text WebSocket message');
}

export function openSonioxStream({
  apiKey,
  text,
  voice,
  handlers,
  textChunks,
  webSocket,
}: OpenSonioxStreamOptions): { cancel(): void } {
  const streamId = createStreamId();
  const SocketImpl: SonioxSocketConstructor | undefined =
    webSocket ?? ((globalThis as { WebSocket?: unknown }).WebSocket as SonioxSocketConstructor | undefined);
  let socket: SonioxSocket | null = null;
  let cancelled = false;
  let failed = false;
  let audioEnded = false;
  let terminated = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const clearDeadline = () => clearTimeout(deadline);
  const armDeadline = (ms: number, message: string) => {
    clearDeadline();
    deadline = setTimeout(() => fail(new SonioxProtocolError(message)), ms);
    // Node background generation should not be kept alive by a cancelled test/session.
    (deadline as unknown as { unref?: () => void }).unref?.();
  };

  const finishTermination = () => {
    if (terminated) return;
    terminated = true;
    clearDeadline();
    handlers.onTerminated?.();
  };

  const fail = (error: Error) => {
    if (cancelled || failed) return;
    failed = true;
    clearDeadline();
    try {
      handlers.onError(error);
    } catch {
      // Consumer error reporting is terminal too; never let it escape a
      // WebSocket close/error callback or trigger a second report.
    }
    try {
      socket?.close();
    } catch {}
  };

  const send = (message: object) => {
    try {
      socket?.send(JSON.stringify(message));
    } catch (error) {
      fail(asError(error, 'Unable to send a message to Soniox'));
    }
  };

  try {
    if (!SocketImpl) throw new SonioxProtocolError('No WebSocket implementation is available');
    socket = new SocketImpl(SONIOX_WEBSOCKET_URL);
  } catch (error) {
    fail(asError(error, 'Unable to open Soniox WebSocket'));
    return { cancel() {} };
  }

  armDeadline(15000, 'The audio connection timed out');

  socket.onopen = () => {
    if (cancelled || failed || audioEnded) return;
    armDeadline(20000, 'Audio generation stopped responding');

    send({
      api_key: apiKey,
      model: 'tts-rt-v2',
      language: 'en',
      voice,
      audio_format: 'mp3',
      bitrate: 128000,
      stream_id: streamId,
      return_timestamps: true,
    });

    const chunks = textChunks && textChunks.length > 0 ? textChunks : splitTextIntoSonioxChunks(text);
    for (let index = 0; index < chunks.length && !failed; index += 1) {
      send({ text: chunks[index], text_end: index === chunks.length - 1, stream_id: streamId });
    }
  };

  socket.onmessage = (event) => {
    if (cancelled || failed || terminated) return;

    let payload: unknown;
    try {
      payload = JSON.parse(decodeTextFrame(event.data));
    } catch (error) {
      fail(asError(error, 'Soniox sent malformed JSON'));
      return;
    }

    if (!isRecord(payload)) {
      fail(new SonioxProtocolError('Soniox sent a malformed WebSocket payload'));
      return;
    }

    if (typeof payload.error_type === 'string') {
      fail(
        payload.error_type === 'temp_api_key_session_expired'
          ? new SonioxTemporaryKeyExpiredError()
          : new SonioxProtocolError(`Soniox returned ${payload.error_type}`)
      );
      return;
    }

    let recognised = false;
    try {
      if ('audio' in payload) {
        recognised = true;
        if (typeof payload.audio !== 'string') throw new SonioxProtocolError('Soniox sent malformed audio');
        const chunk = decodeAudio(payload.audio);
        if (chunk.byteLength > 0 && !audioEnded) {
          armDeadline(20000, 'Audio generation stopped responding');
        }
        handlers.onAudio(chunk);
      }
      if ('timestamps' in payload) {
        recognised = true;
        handlers.onTimestamps(normaliseTimestamps(payload.timestamps));
      }
      if ('audio_end' in payload) {
        recognised = true;
        if (typeof payload.audio_end !== 'boolean') throw new SonioxProtocolError('Soniox sent malformed audio_end');
        if (payload.audio_end && !audioEnded) {
          audioEnded = true;
          armDeadline(10000, 'Audio timing finalization timed out');
          handlers.onDone();
        }
      }
      if ('terminated' in payload) {
        recognised = true;
        if (typeof payload.terminated !== 'boolean') throw new SonioxProtocolError('Soniox sent malformed terminated');
        if (payload.terminated) {
          if (!audioEnded) throw new SonioxProtocolError('Soniox terminated before audio end');
          finishTermination();
          socket?.close();
        }
      }
      if (!recognised) throw new SonioxProtocolError('Soniox sent an unrecognised WebSocket payload');
    } catch (error) {
      fail(asError(error, 'Soniox sent an invalid WebSocket payload'));
    }
  };

  socket.onerror = () => fail(new SonioxProtocolError('Soniox WebSocket error'));
  socket.onclose = () => {
    if (cancelled || failed || terminated) return;
    fail(
      new SonioxProtocolError(
        audioEnded
          ? 'Soniox WebSocket closed before explicit termination'
          : 'Soniox WebSocket closed before audio completed'
      )
    );
  };

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearDeadline();
      try {
        socket?.close();
      } catch {}
    },
  };
}
