import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  openSonioxStream,
  SonioxProtocolError,
  SonioxTemporaryKeyExpiredError,
} from './sonioxStream';
import { createWordTimingAccumulator } from './wordTimings';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  closeCount = 0;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.closeCount += 1;
  }

  open() {
    this.onopen?.({} as Event);
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  closeFromServer() {
    this.onclose?.({} as CloseEvent);
  }

  fail() {
    this.onerror?.({} as Event);
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

function handlers() {
  const audio: Uint8Array[] = [];
  const timestamps: Array<{ characters: string[]; starts: number[]; ends: number[] }> = [];
  const errors: Error[] = [];
  let done = 0;
  let terminated = 0;
  return {
    values: { audio, timestamps, errors, get done() { return done; }, get terminated() { return terminated; } },
    handlers: {
      onAudio: (chunk: Uint8Array) => audio.push(chunk),
      onTimestamps: (batch: { characters: string[]; starts: number[]; ends: number[] }) => timestamps.push(batch),
      onDone: () => { done += 1; },
      onTerminated: () => { terminated += 1; },
      onError: (error: Error) => errors.push(error),
    },
  };
}

test('sends the required configuration before ordered chunks and marks only the last text message complete', () => {
  const text = Array.from({ length: 230 }, (_, index) =>
    `word${index}${index < 229 ? indexWithWhitespace(index) : ''}`
  ).join('');
  const received = handlers();
  openSonioxStream({ apiKey: 'temporary-key', text, voice: 'Adrian', handlers: received.handlers });
  const socket = FakeWebSocket.instances[0]!;

  socket.open();

  expect(socket.url).toBe('wss://tts-rt.soniox.com/tts-websocket');
  const messages = socket.sent.map((message) => JSON.parse(message));
  const [config, ...texts] = messages;
  expect(config).toMatchObject({
    api_key: 'temporary-key',
    model: 'tts-rt-v2',
    language: 'en',
    voice: 'Adrian',
    audio_format: 'mp3',
    bitrate: 128000,
    return_timestamps: true,
  });
  expect(config.speed).toBeUndefined();
  expect(typeof config.stream_id).toBe('string');
  expect(texts.length).toBeGreaterThan(1);
  expect(texts.map((message) => message.text).join('')).toBe(text.trim());
  expect(texts.slice(0, -1).every((message) => message.text_end === false)).toBe(true);
  expect(texts.filter((message) => message.text_end === true)).toHaveLength(1);
  expect(texts.at(-1)?.text_end).toBe(true);
  expect(texts.every((message) => message.stream_id === config.stream_id)).toBe(true);
});

function indexWithWhitespace(index: number): string {
  return index % 3 === 0 ? '\n\n' : index % 2 === 0 ? '   ' : ' ';
}

test('delivers independent audio and timestamp messages then completes exactly once at audio end', () => {
  const received = handlers();
  openSonioxStream({ apiKey: 'key', text: 'Hi', voice: 'Adrian', handlers: received.handlers });
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  socket.receive({ audio: 'AQID', stream_id: 'stream' });
  socket.receive({
    timestamps: {
      characters: ['H', 'i'],
      character_start_times_seconds: [0.1, 0.2],
      character_end_times_seconds: [0.15, 0.25],
    },
    stream_id: 'stream',
  });
  socket.receive({ audio: 'BA==', audio_end: true, stream_id: 'stream' });
  socket.receive({
    timestamps: {
      characters: ['!'],
      character_start_times_seconds: [0.26],
      character_end_times_seconds: [0.3],
    },
    stream_id: 'stream',
  });
  socket.receive({ terminated: true, stream_id: 'stream' });

  expect(received.values.audio.map((chunk) => [...chunk])).toEqual([[1, 2, 3], [4]]);
  expect(received.values.timestamps).toEqual([
    { characters: ['H', 'i'], starts: [0.1, 0.2], ends: [0.15, 0.25] },
    { characters: ['!'], starts: [0.26], ends: [0.3] },
  ]);
  expect(received.values.done).toBe(1);
  expect(received.values.terminated).toBe(1);
  expect(received.values.errors).toEqual([]);
  expect(socket.closeCount).toBe(1);
});

test('reports malformed timestamp payloads as protocol errors', () => {
  const received = handlers();
  openSonioxStream({ apiKey: 'key', text: 'Hi', voice: 'Adrian', handlers: received.handlers });
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  socket.receive({
    timestamps: {
      characters: ['H'],
      character_start_times_seconds: [0.1],
      character_end_times_seconds: [],
    },
  });

  expect(received.values.errors).toHaveLength(1);
  expect(received.values.errors[0]).toBeInstanceOf(SonioxProtocolError);
  expect(socket.closeCount).toBe(1);
});

test('reports expired temporary keys with a distinct typed error', () => {
  const received = handlers();
  openSonioxStream({ apiKey: 'key', text: 'Hi', voice: 'Adrian', handlers: received.handlers });
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  socket.receive({ error_code: 403, error_type: 'temp_api_key_session_expired' });

  expect(received.values.errors).toHaveLength(1);
  expect(received.values.errors[0]).toBeInstanceOf(SonioxTemporaryKeyExpiredError);
});

test('reports socket errors and close-before-done as failures', () => {
  const onSocketError = handlers();
  openSonioxStream({ apiKey: 'key', text: 'Hi', voice: 'Adrian', handlers: onSocketError.handlers });
  const failingSocket = FakeWebSocket.instances[0]!;
  failingSocket.open();
  failingSocket.fail();
  expect(onSocketError.values.errors).toHaveLength(1);

  const onEarlyClose = handlers();
  openSonioxStream({ apiKey: 'key', text: 'Hi', voice: 'Adrian', handlers: onEarlyClose.handlers });
  const closingSocket = FakeWebSocket.instances[1]!;
  closingSocket.open();
  closingSocket.closeFromServer();
  expect(onEarlyClose.values.errors).toHaveLength(1);
  expect(onEarlyClose.values.errors[0]).toBeInstanceOf(SonioxProtocolError);
});

test('audio_end followed by socket close is a failure until explicit termination arrives', () => {
  const received = handlers();
  openSonioxStream({ apiKey: 'key', text: 'Hi', voice: 'Adrian', handlers: received.handlers });
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  socket.receive({ audio_end: true });
  socket.closeFromServer();

  expect(received.values.done).toBe(1);
  expect(received.values.terminated).toBe(0);
  expect(received.values.errors).toHaveLength(1);
  expect(received.values.errors[0]?.message).toMatch(/terminat/i);
});

test('contains an exception from the error handler and reports a close failure only once', () => {
  let errorCalls = 0;
  openSonioxStream({
    apiKey: 'key',
    text: 'Hi',
    voice: 'Adrian',
    handlers: {
      onAudio() {},
      onTimestamps() {},
      onDone() {},
      onError() {
        errorCalls += 1;
        throw new Error('consumer error handler failed');
      },
    },
  });
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  expect(() => socket.closeFromServer()).not.toThrow();
  expect(() => socket.fail()).not.toThrow();
  expect(errorCalls).toBe(1);
});

test('turns an incomplete character stream into one WebSocket failure', () => {
  const accumulator = createWordTimingAccumulator('Exact timing');
  const received = handlers();
  openSonioxStream({
    apiKey: 'key',
    text: 'Exact timing',
    voice: 'Adrian',
    handlers: {
      ...received.handlers,
      onTimestamps: (batch) => {
        accumulator.append(batch);
      },
      onTerminated: () => {
        accumulator.flush();
      },
    },
  });
  const socket = FakeWebSocket.instances[0]!;
  socket.open();
  // Only the first word is ever voiced; `flush()` on termination rejects it.
  const characters = [...'Exact'];
  socket.receive({
    timestamps: {
      characters,
      character_start_times_seconds: characters.map((_, index) => index * 0.1),
      character_end_times_seconds: characters.map((_, index) => index * 0.1 + 0.05),
    },
  });
  socket.receive({ audio_end: true });
  socket.receive({ terminated: true });

  expect(received.values.terminated).toBe(0);
  expect(received.values.errors).toHaveLength(1);
  expect(received.values.errors[0]?.message).toMatch(/character stream/i);
});

test('cancel closes the socket and suppresses all later events', () => {
  const received = handlers();
  const stream = openSonioxStream({ apiKey: 'key', text: 'Hi', voice: 'Adrian', handlers: received.handlers });
  const socket = FakeWebSocket.instances[0]!;
  socket.open();

  stream.cancel();
  socket.receive({ audio: 'AQID', audio_end: true });
  socket.receive({ error_type: 'temp_api_key_session_expired' });
  socket.closeFromServer();

  expect(socket.closeCount).toBe(1);
  expect(received.values.audio).toEqual([]);
  expect(received.values.timestamps).toEqual([]);
  expect(received.values.done).toBe(0);
  expect(received.values.terminated).toBe(0);
  expect(received.values.errors).toEqual([]);
});
