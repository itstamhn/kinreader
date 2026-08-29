import { test, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { ConvexReactClient } from 'convex/react';
import { App } from './App';
import { ConvexAppProvider } from './lib/convex';
import { SpeechEngine } from './utils/speechEngine';

function renderApp() {
  return render(
    <ConvexAppProvider>
      <App />
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
