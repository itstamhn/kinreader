import { test, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { ConvexReactClient } from 'convex/react';
import { App, fitEstimatedTail } from './App';
import { ConvexAppProvider } from './lib/convex';
import { SpeechEngine } from './utils/speechEngine';
import {
  SonioxTemporaryKeyExpiredError,
  type OpenSonioxStreamOptions,
} from './utils/sonioxStream';

type TestAppProps = {
  streamingTransport?: (options: OpenSonioxStreamOptions) => { cancel(): void };
  requestTemporaryKey?: (clientId: string) => Promise<{ apiKey: string; expiresAt: string }>;
  loadExactTrack?: (input: { url: string; voice: string }) => Promise<{
    audioUrl: string;
    words: Array<{ text: string; start: number; end: number }>;
    duration: number;
    timingsSource: 'soniox';
  } | null>;
  persistExactTrack?: (input: {
    url: string;
    title?: string;
    author?: string;
    text: string;
    voice: string;
    blob: Blob;
    duration: number;
    words: Array<{ text: string; start: number; end: number }>;
  }) => Promise<void>;
  serverExactCacheEnabled?: boolean;
  requestPregeneration?: (input: {
    title?: string;
    author?: string;
    text: string;
    voice: string;
    clientId: string;
  }) => Promise<unknown>;
  pregenerationStatus?: (input: { contentDigest: string; voice: string }) => Promise<{
    status: 'none' | 'running' | 'done' | 'failed';
    startedAt: number | null;
  }>;
  pregenerationPollMs?: number;
};

function renderApp(props: TestAppProps = {}) {
  return render(
    <ConvexAppProvider>
      <App
        streamingTransport={props.streamingTransport}
        requestTemporaryKey={
          props.requestTemporaryKey ??
          (() => Promise.reject(new Error('temporary keys are disabled in non-streaming App tests')))
        }
        loadExactTrack={props.loadExactTrack ?? (() => Promise.resolve(null))}
        persistExactTrack={props.persistExactTrack ?? (() => Promise.resolve())}
        serverExactCacheEnabled={props.serverExactCacheEnabled ?? true}
        requestPregeneration={props.requestPregeneration ?? (() => Promise.resolve())}
        pregenerationStatus={
          props.pregenerationStatus ?? (() => Promise.resolve({ status: 'none' as const, startedAt: null }))
        }
        pregenerationPollMs={props.pregenerationPollMs ?? 10}
      />
    </ConvexAppProvider>
  );
}

const originalFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  window.location.href = 'http://localhost/';
});

afterEach(async () => {
  cleanup();
  // nuqs batches URL writes on a short throttle; a `setQueryUrl` from the
  // test that just finished can otherwise flush *after* the next test has
  // set its own location, handing it the previous article's `?url=`.
  await new Promise((resolve) => setTimeout(resolve, 80));
  global.fetch = originalFetch;
  localStorage.clear();
  window.location.href = 'http://localhost/';
});

test('a forged auth_token in the URL is ignored and leaves user signed out', async () => {
  window.location.href =
    'http://localhost/?auth_token=forged&email=victim@example.com&name=Attacker&avatar=https://evil.example/a.png';

  const { container } = renderApp();

  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(localStorage.getItem('kinreader_user')).toBeNull();
  expect(container.textContent).not.toContain('victim@example.com');
  expect(container.textContent).not.toContain('Attacker');
  expect(container.textContent).toContain('Sign In');
});

test('an auth_error from the OAuth redirect reopens the sign-in modal with the reason', async () => {
  window.location.href =
    'http://localhost/?auth_error=Google%20sign-in%20is%20not%20configured%20yet';

  const { container } = renderApp();

  await waitFor(() => {
    expect(container.textContent).toContain('Google sign-in is not configured yet');
  });

  // The failure is shown in the in-page auth screen, and it does not sign anyone in.
  expect(container.textContent).toContain('Sign In');
  expect(container.textContent).toContain('Back to Reader');
  expect(localStorage.getItem('kinreader_user')).toBeNull();
  // The reason is consumed, not left in the address bar to reappear on reload.
  expect(window.location.search).toBe('');
});

test('an invalid Better Auth magic link opens sign-in with a recovery message', async () => {
  window.location.href = 'http://localhost/?error=INVALID_TOKEN';

  const { container } = renderApp();

  await waitFor(() => {
    expect(container.textContent).toContain(
      'This sign-in link is invalid or has expired. Request a new link and try again.'
    );
  });

  expect(container.textContent).toContain('Sign In');
  expect(container.textContent).toContain('Back to Reader');
  expect(localStorage.getItem('kinreader_user')).toBeNull();
  expect(window.location.search).toBe('');
});

test('a Better Auth error description is shown and consumed after redirect', async () => {
  window.location.href =
    'http://localhost/?error=INVALID_TOKEN&error_description=This%20link%20was%20already%20used';

  const { container } = renderApp();

  await waitFor(() => {
    expect(container.textContent).toContain('This link was already used');
  });

  expect(localStorage.getItem('kinreader_user')).toBeNull();
  expect(window.location.search).toBe('');
});

// Regression test for plan 018 Bug 1: the engine-construction effect used to
// depend on `[isRampEnabled]`, so toggling ramp mode from the header tore
// down the live SpeechEngine and reconstructed a fresh one -- which
// re-ran `loadAudioUrl('/sample_audio.mp3', ...)` and silently dropped
// whatever audio/article was actually loaded. Before the fix, this test
// fails: `loadAudioUrl` is called a second time purely from toggling ramp.
test('toggling ramp mode does not reconstruct the speech engine (plan 018 Bug 1)', async () => {
  const loadAudioUrlCalls: string[] = [];
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  SpeechEngine.prototype.loadAudioUrl = function (
    this: SpeechEngine,
    url: string,
    words: any,
    duration: number
  ) {
    loadAudioUrlCalls.push(url);
    return originalLoadAudioUrl.call(this, url, words, duration);
  };

  try {
    const { container } = renderApp();

    // The mount effect pre-loads the sample audio once.
    await waitFor(() => expect(loadAudioUrlCalls.length).toBeGreaterThanOrEqual(1));
    const callsAfterMount = loadAudioUrlCalls.length;

    const rampButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Ramp')
    ) as HTMLButtonElement;
    expect(rampButton).toBeTruthy();

    fireEvent.click(rampButton);
    // Let any effect teardown/setup from the state change settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(loadAudioUrlCalls.length).toBe(callsAfterMount);
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
  }
});

// Regression test for plan 018 Step 4: a rejected/empty TTS synthesis used
// to fall back to the on-device voice completely silently -- the old loading
// boolean only ever went back to `false`, indistinguishable from a normal
// neural load. It must land in the 'degraded' status and say so in the
// controls, not silently look like 'ready'.
test('a failed synthesis lands in degraded status and is shown to the reader, not silently ready', async () => {
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  SpeechEngine.prototype.loadAudioUrl = () => {
    throw new Error('audio load failed');
  };

  try {
    const { container } = renderApp();

    const addButton = container.querySelector('button[title="Add Article or URL"]') as HTMLButtonElement;
    expect(addButton).toBeTruthy();
    fireEvent.click(addButton);

    const textTabButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Paste Raw Text')
    ) as HTMLButtonElement;
    fireEvent.click(textTabButton);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Some article body long enough to narrate.' } });

    const narrateButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Narrate now')
    ) as HTMLButtonElement;
    fireEvent.click(narrateButton);

    await waitFor(() => {
      expect(container.textContent).toContain('Neural voice unavailable');
    });

    // Never silently reported as if the neural voice had loaded.
    expect(container.textContent).not.toContain('undefined');
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
  }
});

test('when speech synthesis is unsupported and neural synthesis fails, lands in error status', async () => {
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  SpeechEngine.prototype.loadAudioUrl = () => {
    throw new Error('audio load failed');
  };

  const originalIsSupported = SpeechEngine.prototype.isSpeechSynthesisSupported;
  SpeechEngine.prototype.isSpeechSynthesisSupported = () => false;

  try {
    const { container } = renderApp();

    const addButton = container.querySelector('button[title="Add Article or URL"]') as HTMLButtonElement;
    fireEvent.click(addButton);

    const textTabButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Paste Raw Text')
    ) as HTMLButtonElement;
    fireEvent.click(textTabButton);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Some article body long enough to narrate.' } });

    const narrateButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Narrate now')
    ) as HTMLButtonElement;
    fireEvent.click(narrateButton);

    await waitFor(() => {
      expect(container.textContent).toContain('Audio playback unavailable');
    });
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
    SpeechEngine.prototype.isSpeechSynthesisSupported = originalIsSupported;
  }
});

test('a global paste event with a valid URL opens the clipboard detection sheet', async () => {
  const { container } = renderApp();

  const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as any;
  pasteEvent.clipboardData = {
    getData: (format: string) => (format === 'text' ? 'https://theatlantic.com/ideas/future-of-reading' : ''),
  };

  act(() => {
    window.dispatchEvent(pasteEvent);
  });

  await waitFor(() => {
    expect(container.textContent).toContain('Link on your clipboard');
    expect(container.textContent).toContain('theatlantic.com/ideas/future-of-reading');
  });
});

test('loading app with ?url= parameter extracts and opens that article', async () => {
  window.location.href = 'http://localhost/?url=https%3A%2F%2Fpaulgraham.com%2Flesson.html';

  const originalAction = ConvexReactClient.prototype.action;
  ConvexReactClient.prototype.action = (async (actionName: any, args: any) => {
    const name = typeof actionName === 'string' ? actionName : actionName?.name || '';
    if (name.includes('extractArticle') || name.includes('extract') || args?.url) {
      return {
        title: 'What You (Will) Wish You Knew',
        content: 'When I was in high school, I had to take a course in Latin.',
        author: 'Paul Graham',
        sourceUrl: 'https://paulgraham.com/lesson.html',
      };
    }
    return { audioUrl: '/sample_audio.mp3', wordTimings: [], duration: 5 };
  }) as typeof originalAction;

  try {
    const { container } = renderApp();

    await waitFor(() => {
      expect(container.textContent).toContain('What You (Will) Wish You Knew');
      expect(container.textContent).toContain('Paul Graham');
    });
  } finally {
    ConvexReactClient.prototype.action = originalAction;
  }
});

test('opening library drawer updates the browser URL with ?view=queue', async () => {
  window.location.href = 'http://localhost/';
  const { container } = renderApp();

  const libraryButton = Array.from(container.querySelectorAll('button')).find((b) =>
    b.getAttribute('title')?.includes('Open Reading Queue') || b.textContent?.includes('Queue') || b.querySelector('svg')
  );

  const playlistButton = container.querySelector('button[title*="Reading Queue"]') as HTMLButtonElement;
  if (playlistButton) {
    fireEvent.click(playlistButton);
    expect(window.location.search).toContain('view=queue');
  }
});

async function narrateRawText(container: HTMLElement, text: string) {
  const addButton = container.querySelector('button[title="Add Article or URL"]') as HTMLButtonElement;
  fireEvent.click(addButton);
  const textTabButton = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Paste Raw Text')
  ) as HTMLButtonElement;
  fireEvent.click(textTabButton);
  fireEvent.change(container.querySelector('textarea') as HTMLTextAreaElement, { target: { value: text } });
  const narrateButton = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Narrate now')
  ) as HTMLButtonElement;
  fireEvent.click(narrateButton);
}

function timestampBatch(text: string, start = 0.1) {
  const characters = [...text];
  return {
    characters,
    starts: characters.map((_, index) => Number((start + index * 0.05).toFixed(3))),
    ends: characters.map((_, index) => Number((start + (index + 1) * 0.05).toFixed(3))),
  };
}

const exactWords = [
  { text: 'Exact', start: 0.1, end: 0.35 },
  { text: 'timing', start: 0.4, end: 0.7 },
];

function fakeStreamingTransport() {
  const streams: Array<{
    options: OpenSonioxStreamOptions;
    cancelCalls: number;
  }> = [];
  return {
    streams,
    open(options: OpenSonioxStreamOptions) {
      const stream = { options, cancelCalls: 0 };
      streams.push(stream);
      return { cancel: () => { stream.cancelCalls += 1; } };
    },
  };
}

test('progressive WebSocket playback and Space wait for buffered audio', async () => {
  const transport = fakeStreamingTransport();
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalPlay = SpeechEngine.prototype.play;
  let playCalls = 0;

  class ProgressiveMediaSource {
    static isTypeSupported() { return true; }
    readyState = 'closed';
    addEventListener() {}
    removeEventListener() {}
  }

  (window as any).MediaSource = ProgressiveMediaSource;
  (window as any).ManagedMediaSource = undefined;
  URL.createObjectURL = () => 'blob:progressive-source';
  SpeechEngine.prototype.play = function () {
    playCalls += 1;
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: 'soon' }),
    });
    await narrateRawText(container, 'Progressive playback');
    await waitFor(() => expect(transport.streams).toHaveLength(1));

    const playButton = container.querySelector('button[title*="Play"]') as HTMLButtonElement;
    expect(playButton.disabled).toBe(true);
    expect(container.textContent).not.toContain('Neural voice unavailable');

    fireEvent.keyDown(window, { code: 'Space' });
    expect(playCalls).toBe(0);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
    SpeechEngine.prototype.play = originalPlay;
  }
});

test('without MediaSource Play unlocks when audio is ready', async () => {
  const transport = fakeStreamingTransport();
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  let elementPlays = 0;

  (window as any).MediaSource = undefined;
  (window as any).ManagedMediaSource = undefined;
  URL.createObjectURL = () => 'blob:part';

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: 'soon' }),
    });
    await narrateRawText(container, 'Blob playback');
    await waitFor(() => expect(transport.streams).toHaveLength(1));
    const engine = (window as any).__engine as SpeechEngine;
    (engine as any).audio.play = function () {
      elementPlays += 1;
      return Promise.resolve();
    };

    // An empty stream cannot start via either the button or Space.
    const playButton = container.querySelector('button[title*="Play"]') as HTMLButtonElement;
    expect(playButton.disabled).toBe(true);
    expect(container.textContent).not.toContain('Neural voice unavailable');
    fireEvent.keyDown(window, { code: 'Space' });
    expect(engine.isPlaying).toBe(false);
    expect(engine.getSnapshot().canStartPlayback).toBe(false);
    expect(elementPlays).toBe(0);

    act(() => {
      transport.streams[0]!.options.handlers.onAudio(new Uint8Array([1, 2, 3]));
      transport.streams[0]!.options.handlers.onTimestamps(timestampBatch('Blob playback'));
      transport.streams[0]!.options.handlers.onDone();
    });

    // A short completed recording unlocks immediately, without a minute-long wait.
    expect(playButton.disabled).toBe(false);
    fireEvent.keyDown(window, { code: 'Space' });
    await waitFor(() => expect(elementPlays).toBe(1));
    expect(engine.getSnapshot().isBuffering).toBe(false);
    expect(container.textContent).not.toContain('Neural voice unavailable');
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
  }
});

test('exact timestamp batches replace the estimated prefix and reach the engine authoritatively', async () => {
  const transport = fakeStreamingTransport();
  const originalAppend = SpeechEngine.prototype.appendWordTimings;
  const updates: Array<{ words: any[]; authoritative: boolean }> = [];
  SpeechEngine.prototype.appendWordTimings = function (words, duration, options) {
    updates.push({ words, authoritative: options?.authoritative === true });
    return originalAppend.call(this, words, duration, options);
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: '2026-08-29T12:00:00Z' }),
    });
    await narrateRawText(container, 'Exact timing');
    await waitFor(() => expect(transport.streams).toHaveLength(1));

    act(() => transport.streams[0]!.options.handlers.onTimestamps(timestampBatch('Exact timing')));
    expect(updates.at(-1)).toEqual({
      authoritative: true,
      words: [
        { text: 'Exact', start: 0.1, end: 0.35 },
        { text: 'timing', start: 0.35, end: 0.728 },
      ],
    });

    act(() => {
      transport.streams[0]!.options.handlers.onAudio(new Uint8Array([1, 2, 3]));
      transport.streams[0]!.options.handlers.onDone();
      transport.streams[0]!.options.handlers.onTerminated?.();
    });

    await waitFor(() => {
      const final = updates.at(-1)!;
      expect(final.authoritative).toBe(true);
      expect(final.words).toEqual([
        { text: 'Exact', start: 0.1, end: 0.35 },
        { text: 'timing', start: 0.4, end: 0.7 },
      ]);
    });
  } finally {
    SpeechEngine.prototype.appendWordTimings = originalAppend;
  }
});

test('switching articles cancels the old socket and ignores all of its later callbacks', async () => {
  const transport = fakeStreamingTransport();
  const originalAppendAudio = SpeechEngine.prototype.appendAudioChunk;
  const appendedBytes: number[][] = [];
  SpeechEngine.prototype.appendAudioChunk = function (chunk) {
    appendedBytes.push([...chunk]);
    return originalAppendAudio.call(this, chunk);
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: '2026-08-29T12:00:00Z' }),
    });
    await narrateRawText(container, 'First article');
    await waitFor(() => expect(transport.streams).toHaveLength(1));
    await narrateRawText(container, 'Second article');
    await waitFor(() => expect(transport.streams).toHaveLength(2));

    expect(transport.streams[0]!.cancelCalls).toBe(1);
    act(() => {
      transport.streams[0]!.options.handlers.onAudio(new Uint8Array([9]));
      transport.streams[0]!.options.handlers.onTimestamps(timestampBatch('First article'));
      transport.streams[1]!.options.handlers.onAudio(new Uint8Array([2]));
    });

    expect(appendedBytes).toEqual([[2]]);
  } finally {
    SpeechEngine.prototype.appendAudioChunk = originalAppendAudio;
  }
});

test('unmount invalidates pending key issuance so it cannot open a late socket', async () => {
  const transport = fakeStreamingTransport();
  let resolveKey!: (key: { apiKey: string; expiresAt: string }) => void;
  const pendingKey = new Promise<{ apiKey: string; expiresAt: string }>((resolve) => {
    resolveKey = resolve;
  });
  const rendered = renderApp({
    streamingTransport: transport.open,
    requestTemporaryKey: () => pendingKey,
  });

  await narrateRawText(rendered.container, 'Unmount before key issuance');
  rendered.unmount();
  resolveKey({ apiKey: 'late-key', expiresAt: '2026-08-29T12:00:00Z' });
  await act(async () => { await Promise.resolve(); });

  expect(transport.streams).toHaveLength(0);
});

test('temporary-key expiry resets the session, retries once, then uses REST without a third key', async () => {
  const transport = fakeStreamingTransport();
  let keyRequests = 0;
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  const restUrls: string[] = [];
  SpeechEngine.prototype.loadAudioUrl = function (url, words, duration) {
    if (url.startsWith('/api/tts/stream')) restUrls.push(url);
    return originalLoadAudioUrl.call(this, url, words, duration);
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({
        apiKey: `temporary-key-${++keyRequests}`,
        expiresAt: '2026-08-29T12:00:00Z',
      }),
    });
    await narrateRawText(container, 'Retry this article once');
    await waitFor(() => expect(transport.streams).toHaveLength(1));
    act(() => transport.streams[0]!.options.handlers.onError(new SonioxTemporaryKeyExpiredError()));
    await waitFor(() => expect(transport.streams).toHaveLength(2));
    act(() => transport.streams[1]!.options.handlers.onError(new SonioxTemporaryKeyExpiredError()));

    await waitFor(() => expect(restUrls).toHaveLength(1));
    expect(keyRequests).toBe(2);
    expect(transport.streams).toHaveLength(2);
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
  }
});

test('a WebSocket failure falls back to REST and reports degraded playback', async () => {
  const transport = fakeStreamingTransport();
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  const originalLoadBrowserText = SpeechEngine.prototype.loadBrowserText;
  const restUrls: string[] = [];
  const browserFallbackTexts: string[] = [];
  SpeechEngine.prototype.loadAudioUrl = function (url, words, duration, onError) {
    if (url.startsWith('/api/tts/stream')) restUrls.push(url);
    return originalLoadAudioUrl.call(this, url, words, duration, onError);
  };
  SpeechEngine.prototype.loadBrowserText = function (text, words) {
    browserFallbackTexts.push(text);
    return originalLoadBrowserText.call(this, text, words);
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: '2026-08-29T12:00:00Z' }),
    });
    await narrateRawText(container, 'Fallback through REST');
    await waitFor(() => expect(transport.streams).toHaveLength(1));
    act(() => transport.streams[0]!.options.handlers.onError(new Error('socket blocked')));

    await waitFor(() => {
      expect(restUrls).toHaveLength(1);
      // REST still plays the neural voice; what it lacks is exact word sync,
      // and the notice must say that rather than claim on-device speech.
      expect(container.textContent).toContain('Exact word sync unavailable');
    });
    expect(container.textContent).not.toContain('Neural voice unavailable');
    expect(restUrls[0]).toContain('clientId=');

    act(() => (window as any).__engine.audio.onerror(new Event('error')));
    await waitFor(() => expect(browserFallbackTexts).toContain('Fallback through REST'));
    await waitFor(() => expect(container.textContent).toContain('Neural voice unavailable'));
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
    SpeechEngine.prototype.loadBrowserText = originalLoadBrowserText;
  }
});

test('timestamps that stop lining up mid-stream keep the audio and degrade only the sync, without a second synthesis', async () => {
  const transport = fakeStreamingTransport();
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  const restUrls: string[] = [];
  SpeechEngine.prototype.loadAudioUrl = function (url, words, duration, onError) {
    if (url.startsWith('/api/tts/stream')) restUrls.push(url);
    return originalLoadAudioUrl.call(this, url, words, duration, onError);
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: '2026-08-29T12:00:00Z' }),
    });
    await narrateRawText(container, 'Exact timing lost here');
    await waitFor(() => expect(transport.streams).toHaveLength(1));
    const { handlers } = transport.streams[0]!.options;

    // The first word arrives cleanly; the next batch is unusable (its clock
    // runs backwards), which is the one thing the accumulator still refuses.
    act(() => handlers.onTimestamps(timestampBatch('Exact ')));
    act(() => handlers.onTimestamps(timestampBatch('timing', 0.0)));
    act(() => {
      handlers.onDone();
      handlers.onTerminated?.();
    });

    await waitFor(() => expect(container.textContent).toContain('Exact word sync unavailable'));
    expect(container.textContent).toContain('Reason: exact word sync lost partway (1 words are exact)');
    // No REST re-synthesis, and the live stream was not torn down.
    expect(restUrls).toHaveLength(0);
    expect(transport.streams[0]!.cancelCalls).toBe(0);
    // The exact prefix survives; the rest keeps its estimated spacing.
    const words = (window as any).__engine.words as Array<{ text: string; start: number; end: number }>;
    expect(words.map((word) => word.text)).toEqual(['Exact', 'timing', 'lost', 'here']);
    expect(words[0]).toEqual({ text: 'Exact', start: 0.1, end: 0.35 });
    expect(words[1]!.start).toBeGreaterThanOrEqual(0.35);
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
  }
});

test('fitEstimatedTail stretches only the estimated words onto the audio that arrived', () => {
  const words = [
    { text: 'a', start: 0, end: 1 },
    { text: 'b', start: 1, end: 2 },
    { text: 'c', start: 2, end: 3 },
    { text: 'd', start: 3, end: 4 },
  ];
  expect(fitEstimatedTail(words, 2, 6)).toEqual([
    { text: 'a', start: 0, end: 1 },
    { text: 'b', start: 1, end: 2 },
    { text: 'c', start: 2, end: 4 },
    { text: 'd', start: 4, end: 6 },
  ]);
  // Nothing exact yet: the whole timeline is fitted.
  expect(fitEstimatedTail(words, 0, 2).at(-1)).toEqual({ text: 'd', start: 1.5, end: 2 });
  // Unknown or implausible audio length: leave the estimate alone.
  expect(fitEstimatedTail(words, 2, 0)).toBe(words);
  expect(fitEstimatedTail(words, 2, 40)).toBe(words);
  expect(fitEstimatedTail(words, 4, 6)).toBe(words);
});

test('an exact cache hit loads stored audio before minting a key or opening a socket', async () => {
  const transport = fakeStreamingTransport();
  const cacheRequests: Array<{ url: string; voice: string }> = [];
  let keyRequests = 0;
  const loadedUrls: string[] = [];
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  SpeechEngine.prototype.loadAudioUrl = function (url, words, duration, onError) {
    if (url !== '/sample_audio.mp3') loadedUrls.push(url);
    return originalLoadAudioUrl.call(this, url, words, duration, onError);
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => {
        keyRequests += 1;
        return { apiKey: 'must-not-be-minted', expiresAt: '2026-08-29T12:00:00Z' };
      },
      loadExactTrack: async (input) => {
        cacheRequests.push(input);
        return {
          audioUrl: 'https://cache.example/exact.mp3',
          words: exactWords,
          duration: 0.7,
          timingsSource: 'soniox',
        };
      },
    });

    await narrateRawText(container, 'Exact timing');
    await waitFor(() => expect(loadedUrls).toContain('https://cache.example/exact.mp3'));

    expect(cacheRequests).toHaveLength(1);
    expect(cacheRequests[0]).toEqual({
      url: 'content-sha256:b2d0149d4df84e1408ed3208160aa121666399f06ebc62f7636aaeac1d329fb6',
      voice: 'Adrian',
    });
    expect(keyRequests).toBe(0);
    expect(transport.streams).toHaveLength(0);
    expect(container.textContent).not.toContain('Neural voice unavailable');
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
  }
});

test('anonymous narration skips server exact-cache reads and persistence but keeps WebSocket timing', async () => {
  const transport = fakeStreamingTransport();
  let cacheReads = 0;
  let persistenceCalls = 0;

  const { container } = renderApp({
    serverExactCacheEnabled: false,
    streamingTransport: transport.open,
    requestTemporaryKey: async () => ({ apiKey: 'anonymous-temporary-key', expiresAt: 'soon' }),
    loadExactTrack: async () => {
      cacheReads += 1;
      return null;
    },
    persistExactTrack: async () => {
      persistenceCalls += 1;
    },
  });

  await narrateRawText(container, 'Anonymous exact timing');
  await waitFor(() => expect(transport.streams).toHaveLength(1));
  act(() => {
    transport.streams[0]!.options.handlers.onAudio(new Uint8Array([1, 2, 3]));
    transport.streams[0]!.options.handlers.onTimestamps(timestampBatch('Anonymous exact timing'));
    transport.streams[0]!.options.handlers.onDone();
    transport.streams[0]!.options.handlers.onTerminated?.();
  });

  await act(async () => {
    await Promise.resolve();
  });
  expect(cacheReads).toBe(0);
  expect(persistenceCalls).toBe(0);
});

test('pasted notes share exact audio only when their content is identical', async () => {
  const transport = fakeStreamingTransport();
  const cacheRequests: Array<{ url: string; voice: string }> = [];
  const loadedUrls: string[] = [];
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  SpeechEngine.prototype.loadAudioUrl = function (url, words, duration, onError) {
    if (url !== '/sample_audio.mp3') loadedUrls.push(url);
    return originalLoadAudioUrl.call(this, url, words, duration, onError);
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: '2026-08-29T12:00:00Z' }),
      loadExactTrack: async (input) => {
        cacheRequests.push(input);
        if (input.url !== cacheRequests[0]?.url) return null;
        return {
          audioUrl: 'https://cache.example/first-note.mp3',
          words: exactWords,
          duration: 0.7,
          timingsSource: 'soniox',
        };
      },
    });

    await narrateRawText(container, 'Exact timing');
    await waitFor(() => expect(loadedUrls).toHaveLength(1));

    await narrateRawText(container, 'Second note');
    await waitFor(() => expect(transport.streams).toHaveLength(1));
    expect(cacheRequests[1]!.url).not.toBe(cacheRequests[0]!.url);
    expect(loadedUrls).toHaveLength(1);

    await narrateRawText(container, 'Exact timing');
    await waitFor(() => expect(loadedUrls).toHaveLength(2));
    expect(cacheRequests[2]!.url).toBe(cacheRequests[0]!.url);
    expect(loadedUrls).toEqual([
      'https://cache.example/first-note.mp3',
      'https://cache.example/first-note.mp3',
    ]);
    expect(transport.streams).toHaveLength(1);
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
  }
});

test('exact-track persistence failure does not replace completed WebSocket playback with a fallback', async () => {
  const transport = fakeStreamingTransport();
  const persistenceInputs: Array<Parameters<NonNullable<TestAppProps['persistExactTrack']>>[0]> = [];
  const restUrls: string[] = [];
  const browserFallbackTexts: string[] = [];
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  const originalLoadBrowserText = SpeechEngine.prototype.loadBrowserText;
  SpeechEngine.prototype.loadAudioUrl = function (url, words, duration, onError) {
    if (url.startsWith('/api/tts/stream')) restUrls.push(url);
    return originalLoadAudioUrl.call(this, url, words, duration, onError);
  };
  SpeechEngine.prototype.loadBrowserText = function (text, words) {
    browserFallbackTexts.push(text);
    return originalLoadBrowserText.call(this, text, words);
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: '2026-08-29T12:00:00Z' }),
      loadExactTrack: async () => null,
      persistExactTrack: async (input) => {
        persistenceInputs.push(input);
        throw new Error('persistence unavailable');
      },
    });
    await narrateRawText(container, 'Exact timing');
    await waitFor(() => expect(transport.streams).toHaveLength(1));

    act(() => {
      transport.streams[0]!.options.handlers.onAudio(new Uint8Array([4, 5, 6]));
      transport.streams[0]!.options.handlers.onTimestamps(timestampBatch('Exact timing'));
      transport.streams[0]!.options.handlers.onDone();
      transport.streams[0]!.options.handlers.onTerminated?.();
    });

    await waitFor(() => expect(persistenceInputs).toHaveLength(1));
    expect(await persistenceInputs[0]!.blob.arrayBuffer()).toEqual(new Uint8Array([4, 5, 6]).buffer);
    expect(persistenceInputs[0]).toMatchObject({
      url: 'content-sha256:b2d0149d4df84e1408ed3208160aa121666399f06ebc62f7636aaeac1d329fb6',
      text: 'Exact timing',
      voice: 'Adrian',
      duration: 0.7,
      words: exactWords,
    });
    expect(restUrls).toEqual([]);
    expect(browserFallbackTexts).toEqual([]);
    expect(container.textContent).not.toContain('Neural voice unavailable');
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
    SpeechEngine.prototype.loadBrowserText = originalLoadBrowserText;
  }
});

test('a ?read= share id is resolved into the ?url= load and stripped from the address bar', async () => {
  const sharedUrl = 'https://paulgraham.com/lesson.html';
  const shareId = btoa(sharedUrl).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  window.location.href = `http://localhost/?read=${shareId}`;

  const extractedUrls: string[] = [];
  const originalAction = ConvexReactClient.prototype.action;
  ConvexReactClient.prototype.action = (async (_name: any, args: any) => {
    extractedUrls.push(args?.url);
    return {
      title: 'What You (Will) Wish You Knew',
      content: 'When I was in high school, I had to take a course in Latin.',
      author: 'Paul Graham',
      sourceUrl: sharedUrl,
    };
  }) as typeof originalAction;

  try {
    const { container } = renderApp();
    await waitFor(() => {
      expect(container.textContent).toContain('What You (Will) Wish You Knew');
    });
    expect(extractedUrls).toEqual([sharedUrl]);
    expect(window.location.search).not.toContain('read=');
    expect(new URLSearchParams(window.location.search).get('url')).toBe(sharedUrl);
  } finally {
    ConvexReactClient.prototype.action = originalAction;
  }
});

test('an invalid ?read= id shows a notice and leaves the sample article playable', async () => {
  window.location.href = 'http://localhost/?read=%%%not-valid';
  const { container } = renderApp();
  await waitFor(() => {
    expect(container.textContent).toContain('That share link is not valid');
  });
  expect(window.location.search).not.toContain('read=');
  const playButton = container.querySelector('button[title*="Play"]') as HTMLButtonElement;
  expect(playButton.disabled).toBe(false);
});

test('a failed deep-link extraction shows a load notice instead of silently keeping the sample', async () => {
  window.location.href = 'http://localhost/?url=https%3A%2F%2Fdead.example%2Fpost';
  const originalAction = ConvexReactClient.prototype.action;
  ConvexReactClient.prototype.action = (async () => {
    throw new Error('Too many article requests. Please try again in a minute.');
  }) as typeof originalAction;

  try {
    const { container } = renderApp();
    await waitFor(() => {
      expect(container.textContent).toContain('Could not load dead.example');
      expect(container.textContent).toContain('Too many article requests');
    });
    // Back on the sample article, and it is playable.
    expect(container.textContent).toContain('Dan Koe');
    expect(window.location.search).not.toContain('url=');
  } finally {
    ConvexReactClient.prototype.action = originalAction;
  }
});

test('a deep link shows a fetching state instead of the sample article while extraction runs', async () => {
  window.location.href = 'http://localhost/?url=https%3A%2F%2Fslow.example%2Fpost';
  let resolveExtract!: (value: unknown) => void;
  const originalAction = ConvexReactClient.prototype.action;
  ConvexReactClient.prototype.action = (() =>
    new Promise((resolve) => {
      resolveExtract = resolve;
    })) as typeof originalAction;

  try {
    const { container } = renderApp();
    await waitFor(() => {
      expect(container.textContent).toContain('Fetching article');
      expect(container.textContent).toContain('slow.example');
    });
    expect(container.textContent).not.toContain('digital renaissance');

    resolveExtract({
      title: 'Slow but here',
      content: 'It arrived in the end after a long wait.',
      author: 'Someone',
      sourceUrl: 'https://slow.example/post',
    });
    await waitFor(() => expect(container.textContent).toContain('Slow but here'));
  } finally {
    ConvexReactClient.prototype.action = originalAction;
  }
});

test('opening a saved article resumes from its recorded word once exact timings are loaded', async () => {
  const transport = fakeStreamingTransport();
  const seeks: number[] = [];
  const originalSeek = SpeechEngine.prototype.seekToWordIndex;
  SpeechEngine.prototype.seekToWordIndex = function (index) {
    seeks.push(index);
    return originalSeek.call(this, index);
  };
  const words = Array.from({ length: 12 }, (_, i) => ({
    text: `w${i}`,
    start: i * 0.3,
    end: i * 0.3 + 0.25,
  }));
  const content = words.map((w) => w.text).join(' ');
  localStorage.setItem(
    'kinetic_saved_articles_v2',
    JSON.stringify([
      {
        id: 'https://example.com/resume',
        article: { title: 'Resume me', content, sourceUrl: 'https://example.com/resume' },
        progress: 45,
        lastWordIndex: 7,
        lastReadAt: Date.now(),
      },
    ])
  );
  window.location.href = 'http://localhost/?url=https%3A%2F%2Fexample.com%2Fresume';

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'k', expiresAt: 'soon' }),
      loadExactTrack: async () => ({
        audioUrl: 'https://cache.example/resume.mp3',
        words,
        duration: 3.6,
        timingsSource: 'soniox',
      }),
    });
    await waitFor(() => expect(container.textContent).toContain('Resume me'));
    await waitFor(() => expect(seeks).toContain(7));
    expect(((window as any).__engine as SpeechEngine).currentWordIndex).toBe(7);
    expect(transport.streams).toHaveLength(0);
  } finally {
    SpeechEngine.prototype.seekToWordIndex = originalSeek;
  }
});

test('a socket failure mid-article resumes the REST fallback from the current word', async () => {
  const transport = fakeStreamingTransport();
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const seeks: number[] = [];
  const originalSeek = SpeechEngine.prototype.seekToWordIndex;
  SpeechEngine.prototype.seekToWordIndex = function (index) {
    seeks.push(index);
    return originalSeek.call(this, index);
  };
  class ProgressiveMediaSource {
    static isTypeSupported() { return true; }
    readyState = 'closed';
    addEventListener() {}
    removeEventListener() {}
  }
  (window as any).MediaSource = ProgressiveMediaSource;
  (window as any).ManagedMediaSource = undefined;
  URL.createObjectURL = () => 'blob:progressive-source';

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: 'soon' }),
    });
    await narrateRawText(container, 'one two three four five six seven eight nine ten');
    await waitFor(() => expect(transport.streams).toHaveLength(1));

    // The listener is five words in when the socket dies.
    act(() => ((window as any).__engine as SpeechEngine).seekToWordIndex(5));
    seeks.length = 0;
    act(() => transport.streams[0]!.options.handlers.onError(new Error('socket dropped')));

    await waitFor(() => expect(container.textContent).toContain('Exact word sync unavailable'));
    expect(seeks).toContain(5);
    expect(((window as any).__engine as SpeechEngine).currentWordIndex).toBe(5);
  } finally {
    SpeechEngine.prototype.seekToWordIndex = originalSeek;
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
  }
});

test('ArrowRight and ArrowLeft move between clauses', async () => {
  const { container } = renderApp();
  await waitFor(() => expect(container.textContent).toContain('digital renaissance'));
  const engine = (window as any).__engine as SpeechEngine;
  expect(engine.currentWordIndex).toBe(0);

  fireEvent.keyDown(window, { code: 'ArrowRight' });
  const afterRight = engine.currentWordIndex;
  expect(afterRight).toBeGreaterThan(0);

  fireEvent.keyDown(window, { code: 'ArrowRight' });
  expect(engine.currentWordIndex).toBeGreaterThan(afterRight);

  fireEvent.keyDown(window, { code: 'ArrowLeft' });
  expect(engine.currentWordIndex).toBe(afterRight);
});

test('the header voice toggle mutes the engine', async () => {
  const { container } = renderApp();
  const engine = (window as any).__engine as SpeechEngine;
  expect(engine.muted).toBe(false);

  const voiceButton = container.querySelector('button[title="Toggle Neural Voice"]') as HTMLButtonElement;
  fireEvent.click(voiceButton);
  await waitFor(() => expect(engine.muted).toBe(true));
  expect(container.textContent).toContain('Voice off');

  fireEvent.click(voiceButton);
  await waitFor(() => expect(engine.muted).toBe(false));
});

test('the header share button copies a kinreader.com/r/ link that decodes back to the source', async () => {
  window.location.href = 'http://localhost/';
  const written: string[] = [];
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { written.push(text); } },
  });
  try {
    const { container } = renderApp();
    await waitFor(() => expect(container.textContent).toContain('digital renaissance'));
    const shareButton = container.querySelector('button[title="Share article link"]') as HTMLButtonElement;
    fireEvent.click(shareButton);
    await waitFor(() => expect(written).toHaveLength(1));
    const link = new URL(written[0]!);
    expect(link.origin).toBe('https://kinreader.com');
    expect(link.pathname.startsWith('/r/')).toBe(true);
    expect(link.searchParams.get('t')).toContain('DAN KOE');
  } finally {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
  }
});

test('adding an article to the queue asks the server to pre-generate it', async () => {
  const requests: Array<{ text: string; voice: string; title?: string }> = [];
  const { container } = renderApp({
    requestPregeneration: async (input) => {
      requests.push(input);
    },
  });

  const addButton = container.querySelector('button[title="Add Article or URL"]') as HTMLButtonElement;
  fireEvent.click(addButton);
  const textTabButton = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Paste Raw Text')
  ) as HTMLButtonElement;
  fireEvent.click(textTabButton);
  fireEvent.change(container.querySelector('textarea') as HTMLTextAreaElement, {
    target: { value: 'Queue this for later listening.' },
  });
  const queueButton = Array.from(container.querySelectorAll('button')).find((b) =>
    /add to queue/i.test(b.textContent ?? '')
  ) as HTMLButtonElement;
  expect(queueButton).toBeTruthy();
  fireEvent.click(queueButton);

  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({ text: 'Queue this for later listening.', voice: 'Adrian' });
});

test('anonymous listeners read the global exact cache and skip persistence', async () => {
  const transport = fakeStreamingTransport();
  const cacheReads: Array<{ url: string; voice: string }> = [];
  let persistenceCalls = 0;
  const loadedUrls: string[] = [];
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  SpeechEngine.prototype.loadAudioUrl = function (url, words, duration, onError) {
    if (url !== '/sample_audio.mp3') loadedUrls.push(url);
    return originalLoadAudioUrl.call(this, url, words, duration, onError);
  };

  try {
    const { container } = renderApp({
      // No serverExactCacheEnabled override: reads are on for everyone,
      // persistence follows sign-in (none here).
      serverExactCacheEnabled: undefined,
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'k', expiresAt: 'soon' }),
      loadExactTrack: async (input) => {
        cacheReads.push(input);
        return {
          audioUrl: 'https://cache.example/global.mp3',
          words: exactWords,
          duration: 0.7,
          timingsSource: 'soniox',
        };
      },
      persistExactTrack: async () => {
        persistenceCalls += 1;
      },
    });
    await narrateRawText(container, 'Exact timing');
    await waitFor(() => expect(loadedUrls).toContain('https://cache.example/global.mp3'));
    expect(cacheReads).toHaveLength(1);
    expect(transport.streams).toHaveLength(0);
    expect(persistenceCalls).toBe(0);
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
  }
});

test('narrate now streams once and does not also request server pre-generation', async () => {
  const transport = fakeStreamingTransport();
  const requests: unknown[] = [];
  const { container } = renderApp({
    streamingTransport: transport.open,
    requestTemporaryKey: async () => ({ apiKey: 'k', expiresAt: 'soon' }),
    requestPregeneration: async (input) => {
      requests.push(input);
    },
  });
  await narrateRawText(container, 'Stream this exactly once.');
  await waitFor(() => expect(transport.streams).toHaveLength(1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(requests).toEqual([]);
});

test('an article whose pre-generation is running is awaited and then played from the cache, not streamed', async () => {
  const transport = fakeStreamingTransport();
  let statusPolls = 0;
  let cacheReads = 0;
  const loadedUrls: string[] = [];
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  SpeechEngine.prototype.loadAudioUrl = function (url, words, duration, onError) {
    if (url !== '/sample_audio.mp3') loadedUrls.push(url);
    return originalLoadAudioUrl.call(this, url, words, duration, onError);
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'must-not-be-used', expiresAt: 'soon' }),
      loadExactTrack: async () => {
        cacheReads += 1;
        // Miss until the job has finished.
        if (statusPolls < 3) return null;
        return { audioUrl: 'https://cache.example/pregenerated.mp3', words: exactWords, duration: 0.7, timingsSource: 'soniox' };
      },
      pregenerationStatus: async () => {
        statusPolls += 1;
        return { status: statusPolls < 3 ? 'running' : 'done', startedAt: Date.now() - 1000 };
      },
      pregenerationPollMs: 5,
    });
    await narrateRawText(container, 'Exact timing');

    await waitFor(() => expect(container.textContent).toContain('Preparing audio'));
    await waitFor(() => expect(loadedUrls).toContain('https://cache.example/pregenerated.mp3'));
    expect(transport.streams).toHaveLength(0);
    expect(statusPolls).toBe(3);
    expect(cacheReads).toBe(2);
    expect(container.textContent).not.toContain('checking for a saved recording');
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
  }
});

test('a failed pre-generation falls through to a normal live stream', async () => {
  const transport = fakeStreamingTransport();
  const { container } = renderApp({
    streamingTransport: transport.open,
    requestTemporaryKey: async () => ({ apiKey: 'k', expiresAt: 'soon' }),
    loadExactTrack: async () => null,
    pregenerationStatus: async () => ({ status: 'failed', startedAt: Date.now() - 1000 }),
  });
  await narrateRawText(container, 'Exact timing');
  await waitFor(() => expect(transport.streams).toHaveLength(1));
  expect(container.textContent).not.toContain('checking for a saved recording');
});

test('a very long article is narrated as a sentence-aligned prefix and says so', async () => {
  const transport = fakeStreamingTransport();
  const sentence = 'Every sentence in this long article has exactly ten words in it. ';
  const longText = sentence.repeat(1200); // ~80k chars, ~12k words
  const { container } = renderApp({
    streamingTransport: transport.open,
    requestTemporaryKey: async () => ({ apiKey: 'k', expiresAt: 'soon' }),
  });
  await narrateRawText(container, longText);
  await waitFor(() => expect(transport.streams).toHaveLength(1));

  const streamed = transport.streams[0]!.options.text;
  expect(streamed.length).toBeLessThanOrEqual(45000);
  expect(streamed.endsWith('.')).toBe(true);
  expect(longText.startsWith(streamed)).toBe(true);
  await waitFor(() => expect(container.textContent).toMatch(/Long article: narrating the first [\d,]+ of [\d,]+ words/));
  // The displayed word list is the narrated prefix, not the whole text.
  const engine = (window as any).__engine as SpeechEngine;
  expect(engine.words.length).toBe(streamed.split(/\s+/).length);
});

test('the degraded banner names the reason the live stream failed', async () => {
  const transport = fakeStreamingTransport();
  const originalLoadAudioUrl = SpeechEngine.prototype.loadAudioUrl;
  SpeechEngine.prototype.loadAudioUrl = function (url, words, duration, onError) {
    return originalLoadAudioUrl.call(this, url, words, duration, onError);
  };
  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'k', expiresAt: 'soon' }),
    });
    await narrateRawText(container, 'Explain the failure please');
    await waitFor(() => expect(transport.streams).toHaveLength(1));
    act(() => transport.streams[0]!.options.handlers.onError(new Error('Soniox returned too_many_sessions')));
    await waitFor(() => expect(container.textContent).toContain('Reason: live stream failed: Soniox returned too_many_sessions'));
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
  }
});

test('a job left running for longer than the action limit is ignored and the article streams', async () => {
  const transport = fakeStreamingTransport();
  const { container } = renderApp({
    streamingTransport: transport.open,
    requestTemporaryKey: async () => ({ apiKey: 'k', expiresAt: 'soon' }),
    loadExactTrack: async () => null,
    pregenerationStatus: async () => ({ status: 'running', startedAt: Date.now() - 12 * 60 * 1000 }),
  });
  await narrateRawText(container, 'Exact timing');
  await waitFor(() => expect(transport.streams).toHaveLength(1));
  expect(container.textContent).not.toContain('checking for a saved recording');
});

test('Play now stops waiting for a running job and streams instead', async () => {
  const transport = fakeStreamingTransport();
  const { container } = renderApp({
    streamingTransport: transport.open,
    requestTemporaryKey: async () => ({ apiKey: 'k', expiresAt: 'soon' }),
    loadExactTrack: async () => null,
    pregenerationStatus: async () => ({ status: 'running', startedAt: Date.now() - 1000 }),
    pregenerationPollMs: 5,
  });
  await narrateRawText(container, 'Exact timing');
  await waitFor(() => expect(container.textContent).toContain('Preparing audio'));
  expect(transport.streams).toHaveLength(0);

  const playNow = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Play now') as HTMLButtonElement;
  expect(playNow).toBeTruthy();
  fireEvent.click(playNow);

  await waitFor(() => expect(transport.streams).toHaveLength(1));
  expect(container.textContent).not.toContain('checking for a saved recording');
});

test('long REST fallback unlocks playback before its response finishes downloading', async () => {
  const transport = fakeStreamingTransport();
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  const responseBody = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
  global.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === '/api/tts/stream') return new Response(responseBody);
    return originalFetch(input);
  }) as typeof fetch;
  const { container } = renderApp({
    streamingTransport: transport.open,
    requestTemporaryKey: async () => ({ apiKey: 'k', expiresAt: 'soon' }),
  });
  await narrateRawText(container, 'This is a long article about progressive listening. '.repeat(180));
  await waitFor(() => expect(transport.streams).toHaveLength(1));
  act(() => transport.streams[0]!.options.handlers.onError(new Error('socket unavailable')));
  const frames = new Uint8Array(417 * 4000);
  for (let i = 0; i < 4000; i++) frames.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  act(() => body!.enqueue(frames));
  const engine = (window as any).__engine as SpeechEngine;
  await waitFor(() => expect(engine.getSnapshot().canStartPlayback).toBe(true));
  expect(engine.isStreaming).toBe(true);
  expect((container.querySelector('button[title="Play (Space)"]') as HTMLButtonElement).disabled).toBe(false);
  act(() => body!.close());
  await waitFor(() => expect(engine.isStreaming).toBe(false));
});

test('the real cache lookup runs outside render and opens saved audio without generating it again', async () => {
  const originalQuery = ConvexReactClient.prototype.query;
  let cacheReads = 0;
  let keyRequests = 0;
  ConvexReactClient.prototype.query = (async () => {
    cacheReads += 1;
    return {
      audioUrl: '/sample_audio.mp3',
      words: [{ text: 'Cached', start: 0, end: 0.5 }, { text: 'recording', start: 0.5, end: 1 }],
      duration: 1,
      timingsSource: 'soniox',
    };
  }) as typeof ConvexReactClient.prototype.query;
  try {
    const { container } = render(<ConvexAppProvider><App
      requestTemporaryKey={async () => { keyRequests += 1; return { apiKey: 'k', expiresAt: 'soon' }; }}
      pregenerationStatus={async () => ({ status: 'none', startedAt: null })}
    /></ConvexAppProvider>);
    await narrateRawText(container, 'Cached recording');
    await waitFor(() => expect(cacheReads).toBe(1));
    const engine = (window as any).__engine as SpeechEngine;
    expect(engine.getSnapshot().canStartPlayback).toBe(true);
    expect(engine.isStreaming).toBe(false);
    expect(keyRequests).toBe(0);
  } finally {
    cleanup();
    ConvexReactClient.prototype.query = originalQuery;
  }
});

test('the real job-status lookup polls fresh results and opens the completed cache entry', async () => {
  const originalQuery = ConvexReactClient.prototype.query;
  let cacheReads = 0;
  let statusReads = 0;
  let keyRequests = 0;
  ConvexReactClient.prototype.query = (async (_reference: unknown, input: any) => {
    if (input.contentDigest) {
      statusReads += 1;
      return { status: statusReads === 1 ? 'running' : 'done', startedAt: Date.now() };
    }
    cacheReads += 1;
    if (cacheReads === 1) return null;
    return {
      audioUrl: '/sample_audio.mp3', words: [{ text: 'Ready', start: 0, end: 1 }],
      duration: 1, timingsSource: 'soniox',
    };
  }) as typeof ConvexReactClient.prototype.query;
  try {
    const { container } = render(<ConvexAppProvider><App
      requestTemporaryKey={async () => { keyRequests += 1; return { apiKey: 'k', expiresAt: 'soon' }; }}
      pregenerationPollMs={5}
    /></ConvexAppProvider>);
    await narrateRawText(container, 'Ready');
    await waitFor(() => expect(cacheReads).toBe(2));
    expect(statusReads).toBe(2);
    expect(keyRequests).toBe(0);
    expect(((window as any).__engine as SpeechEngine).getSnapshot().canStartPlayback).toBe(true);
  } finally {
    cleanup();
    ConvexReactClient.prototype.query = originalQuery;
  }
});
