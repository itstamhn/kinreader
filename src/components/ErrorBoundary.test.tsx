import { test, expect, afterEach, mock } from 'bun:test';
import { render, cleanup, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

afterEach(() => {
  cleanup();
});

function Bomb(): never {
  throw new Error('boom');
}

test('catches a render-time throw and shows the fallback instead of unmounting the tree', () => {
  // React logs the error to console.error by default when an error boundary
  // catches it. Silence that expected noise for this test.
  const consoleError = console.error;
  console.error = mock(() => {});

  try {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  } finally {
    console.error = consoleError;
  }
});

test('renders children normally when nothing throws', () => {
  render(
    <ErrorBoundary>
      <div>all good</div>
    </ErrorBoundary>
  );

  expect(screen.getByText('all good')).toBeTruthy();
});
