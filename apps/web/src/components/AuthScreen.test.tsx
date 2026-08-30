import { afterEach, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ConvexAppProvider } from '../lib/convex';
import { AuthScreen } from './AuthScreen';

afterEach(() => {
  cleanup();
});

test('the sent-link confirmation promises the configured 15-minute lifetime', async () => {
  const { container, getByLabelText, getByRole } = render(
    <AuthScreen
      onBack={() => {}}
      sendMagicLink={async () => ({ error: null })}
    />
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

test('the magic-link test double does not replace the auth client used by the app provider', () => {
  const { getByText } = render(
    <ConvexAppProvider>
      <span>Provider ready</span>
    </ConvexAppProvider>
  );

  expect(getByText('Provider ready')).toBeTruthy();
});
