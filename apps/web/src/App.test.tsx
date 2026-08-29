import { test, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, waitFor } from '@testing-library/react';
import { App } from './App';
import { ConvexAppProvider } from './lib/convex';

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

  // The failure is shown in the sign-in modal, and it does not sign anyone in.
  expect(container.textContent).toContain('Sign In to Kinreader');
  expect(localStorage.getItem('kinreader_user')).toBeNull();
  // The reason is consumed, not left in the address bar to reappear on reload.
  expect(window.location.search).toBe('');
});
