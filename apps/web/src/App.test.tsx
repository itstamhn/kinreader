import { test, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { ConvexReactClient } from 'convex/react';
import { App } from './App';
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
      />
    </ConvexAppProvider>
  );
}

const originalFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  window.location.href = 'http://localhost/';
});

afterEach(() => {
  cleanup();
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

test('progressive WebSocket playback is enabled immediately and Space uses the same guard', async () => {
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
    expect(playButton.disabled).toBe(false);
    expect(container.textContent).not.toContain('Neural voice unavailable');

    fireEvent.keyDown(window, { code: 'Space' });
    expect(playCalls).toBe(1);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
    SpeechEngine.prototype.play = originalPlay;
  }
});

test('Blob-only WebSocket playback buffers normally, blocks Space, then enables play at audio_end', async () => {
  const transport = fakeStreamingTransport();
  const originalMediaSource = (window as any).MediaSource;
  const originalManagedMediaSource = (window as any).ManagedMediaSource;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalPlay = SpeechEngine.prototype.play;
  let playCalls = 0;

  (window as any).MediaSource = undefined;
  (window as any).ManagedMediaSource = undefined;
  URL.createObjectURL = () => 'blob:completed-source';
  SpeechEngine.prototype.play = function () {
    playCalls += 1;
  };

  try {
    const { container } = renderApp({
      streamingTransport: transport.open,
      requestTemporaryKey: async () => ({ apiKey: 'temporary-key', expiresAt: 'soon' }),
    });
    await narrateRawText(container, 'Blob playback');
    await waitFor(() => expect(transport.streams).toHaveLength(1));

    let playButton = container.querySelector('button[title*="Play"]') as HTMLButtonElement;
    expect(playButton.disabled).toBe(true);
    expect(container.textContent).not.toContain('Neural voice unavailable');
    fireEvent.keyDown(window, { code: 'Space' });
    expect(playCalls).toBe(0);

    act(() => {
      transport.streams[0]!.options.handlers.onAudio(new Uint8Array([1, 2, 3]));
      transport.streams[0]!.options.handlers.onTimestamps(timestampBatch('Blob playback'));
      transport.streams[0]!.options.handlers.onDone();
    });

    await waitFor(() => {
      playButton = container.querySelector('button[title*="Play"]') as HTMLButtonElement;
      expect(playButton.disabled).toBe(false);
    });
    expect(container.textContent).not.toContain('Neural voice unavailable');
    fireEvent.keyDown(window, { code: 'Space' });
    expect(playCalls).toBe(1);
  } finally {
    (window as any).MediaSource = originalMediaSource;
    (window as any).ManagedMediaSource = originalManagedMediaSource;
    URL.createObjectURL = originalCreateObjectURL;
    SpeechEngine.prototype.play = originalPlay;
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
      expect(container.textContent).toContain('Neural voice unavailable');
    });

    act(() => (window as any).__engine.audio.onerror(new Event('error')));
    await waitFor(() => expect(browserFallbackTexts).toContain('Fallback through REST'));
  } finally {
    SpeechEngine.prototype.loadAudioUrl = originalLoadAudioUrl;
    SpeechEngine.prototype.loadBrowserText = originalLoadBrowserText;
  }
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
