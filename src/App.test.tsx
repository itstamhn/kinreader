import { test, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, waitFor } from '@testing-library/react';
import { App } from './App';

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

// Regression test for plan 003: the app used to trust `auth_token`, `email`,
// `name` and `avatar` straight from the URL and sign the user in with no
// server check at all. A URL like this one was a complete, one-click account
// takeover for anyone who could guess or intercept an email address — no
// real token required. Before the fix, this test fails: the user ends up
// signed in as the victim even though `/api/auth/verify` reports failure.
test('a forged auth_token in the URL never signs the user in when verification fails', async () => {
  window.location.href =
    'http://localhost/?auth_token=forged&email=victim@example.com&name=Attacker&avatar=https://evil.example/a.png';

  global.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.includes('/api/auth/verify')) {
      return { ok: false, json: async () => ({ error: 'nope' }) } as Response;
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as any;

  const { container } = render(<App />);

  // Give the verify effect's fetch + microtasks a chance to settle. There is
  // no "it stayed signed out" condition to poll for with waitFor here, so
  // flush the microtask/timer queue a few times instead.
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(localStorage.getItem('kinreader_user')).toBeNull();
  expect(container.textContent).not.toContain('victim@example.com');
  expect(container.textContent).not.toContain('Attacker');
  expect(container.textContent).toContain('Sign In');
});

test('a successful verify signs the user in using the response body, ignoring the URL', async () => {
  window.location.href =
    'http://localhost/?auth_token=real-token&email=victim@example.com&name=UrlSuppliedName';

  const serverUser = {
    email: 'victim@example.com',
    name: 'Server Supplied Name',
    avatar: 'https://example.com/avatar.png',
    tier: 'pro',
  };

  global.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.includes('/api/auth/verify')) {
      return {
        ok: true,
        json: async () => ({ success: true, user: serverUser }),
      } as Response;
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as any;

  render(<App />);

  await waitFor(() => {
    expect(localStorage.getItem('kinreader_user')).not.toBeNull();
  });

  const stored = JSON.parse(localStorage.getItem('kinreader_user')!);
  expect(stored.name).toBe('Server Supplied Name');
  expect(stored.name).not.toBe('UrlSuppliedName');
  expect(stored.email).toBe('victim@example.com');
});
