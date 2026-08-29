import { afterEach, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { authClient } from '../lib/auth-client';
import { AuthScreen } from './AuthScreen';

afterEach(() => {
  cleanup();
  mock.module('../lib/auth-client', () => ({ authClient }));
});

test('the sent-link confirmation promises the configured 15-minute lifetime', async () => {
  mock.module('../lib/auth-client', () => ({
    authClient: {
      signIn: {
        magicLink: async () => ({ data: { status: true }, error: null }),
      },
      signOut: async () => ({ data: null, error: null }),
    },
  }));

  const { container, getByLabelText, getByRole } = render(
    <AuthScreen onBack={() => {}} />
  );

  fireEvent.change(getByLabelText('Email address'), {
    target: { value: 'reader@example.com' },
  });
  fireEvent.click(getByRole('button', { name: 'Continue with Email' }));

  await waitFor(() => {
    expect(container.textContent).toContain('The link will stay active for 15 minutes.');
  });
  expect(container.textContent).not.toContain('30 minutes');
});
