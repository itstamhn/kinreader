import { splitTextIntoSonioxChunks } from '@kinreader/backend/soniox';

export interface SonioxTimestamps {
  characters: string[];
  starts: number[];
  ends: number[];
}

export interface SonioxStreamHandlers {
  onAudio(chunk: Uint8Array): void;
  onTimestamps(timestamps: SonioxTimestamps): void;
  onDone(): void;
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

export interface OpenSonioxStreamOptions {
  apiKey: string;
  text: string;
  voice: string;
  handlers: SonioxStreamHandlers;
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
export function openSonioxStream({ apiKey, text, voice, handlers }: OpenSonioxStreamOptions): { cancel(): void } {
  const streamId = createStreamId();
  let socket: WebSocket | null = null;
  let cancelled = false;
  let failed = false;
  let audioEnded = false;

  const fail = (error: Error) => {
    if (cancelled || failed) return;
    failed = true;
    handlers.onError(error);
    socket?.close();
  };

  const send = (message: object) => {
    try {
      socket?.send(JSON.stringify(message));
    } catch (error) {
      fail(asError(error, 'Unable to send a message to Soniox'));
    }
  };

  try {
    socket = new WebSocket(SONIOX_WEBSOCKET_URL);
  } catch (error) {
    fail(asError(error, 'Unable to open Soniox WebSocket'));
    return { cancel() {} };
  }

  socket.onopen = () => {
    if (cancelled || failed || audioEnded) return;

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

    const chunks = splitTextIntoSonioxChunks(text);
    for (let index = 0; index < chunks.length && !failed; index += 1) {
      send({ text: chunks[index], text_end: index === chunks.length - 1, stream_id: streamId });
    }
  };

  socket.onmessage = (event) => {
    if (cancelled || failed) return;

    let payload: unknown;
    try {
      if (typeof event.data !== 'string') throw new SonioxProtocolError('Soniox sent a non-text WebSocket message');
      payload = JSON.parse(event.data);
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
        handlers.onAudio(decodeAudio(payload.audio));
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
          handlers.onDone();
        }
      }
      if ('terminated' in payload) {
        recognised = true;
        if (typeof payload.terminated !== 'boolean') throw new SonioxProtocolError('Soniox sent malformed terminated');
        if (payload.terminated) {
          if (!audioEnded) throw new SonioxProtocolError('Soniox terminated before audio end');
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
    if (!cancelled && !failed && !audioEnded) {
      fail(new SonioxProtocolError('Soniox WebSocket closed before audio completed'));
    }
  };

  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      socket?.close();
    },
  };
}
