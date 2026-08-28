import { test, expect, afterEach } from 'bun:test';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ConvexReactClient } from 'convex/react';
import { ClipboardDetectSheet } from './ClipboardDetectSheet';
import { ConvexAppProvider } from '../lib/convex';
import type { ArticleData } from '../types';

// Same rationale as UrlInputModal.test.tsx: stub the real network boundary
// (ConvexReactClient#action) rather than mock.module(), which persists
// process-wide across bun:test files.
const originalAction = ConvexReactClient.prototype.action;

afterEach(() => {
  ConvexReactClient.prototype.action = originalAction;
  cleanup();
});

function stubExtractAction(impl: () => Promise<ArticleData>) {
  ConvexReactClient.prototype.action = (async () => impl()) as typeof originalAction;
}

function renderSheet(props: Partial<Parameters<typeof ClipboardDetectSheet>[0]> = {}) {
  const onClose = props.onClose ?? (() => {});
  const onNarrateNow = props.onNarrateNow ?? (() => {});
  const onAddToQueue = props.onAddToQueue ?? (() => {});
  return render(
    <ConvexAppProvider>
      <ClipboardDetectSheet
        isOpen={true}
        onClose={onClose}
        detectedUrl={props.detectedUrl ?? 'https://example.com/article'}
        onNarrateNow={onNarrateNow}
        onAddToQueue={onAddToQueue}
      />
    </ConvexAppProvider>
  );
}

test('narrating a detected URL calls the Convex extract mutation and surfaces the result', async () => {
  const extracted: ArticleData = {
    title: 'Detected Article',
    author: 'Someone',
    content: 'Body content.',
    sourceUrl: 'https://example.com/article',
    sourceType: 'article',
  };
  stubExtractAction(async () => extracted);

  let narrated: ArticleData | null = null;
  let closed = false;
  const { container } = renderSheet({
    onNarrateNow: (article) => {
      narrated = article;
    },
    onClose: () => {
      closed = true;
    },
  });

  const narrateButton = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Narrate now')
  ) as HTMLButtonElement;
  fireEvent.click(narrateButton);

  await waitFor(() => {
    expect(narrated).not.toBeNull();
  });

  expect(narrated!).toEqual(extracted);
  expect(closed).toBe(true);
});

test('a failing extraction shows the error state instead of throwing', async () => {
  stubExtractAction(async () => {
    throw new Error('Failed to extract article');
  });

  let narrateCalled = false;
  const { container } = renderSheet({
    onNarrateNow: () => {
      narrateCalled = true;
    },
  });

  const narrateButton = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Narrate now')
  ) as HTMLButtonElement;

  expect(() => fireEvent.click(narrateButton)).not.toThrow();

  await waitFor(() => {
    expect(container.textContent).toContain('Failed to extract article');
  });

  expect(narrateCalled).toBe(false);
});
