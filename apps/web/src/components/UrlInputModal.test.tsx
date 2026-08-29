import { test, expect, afterEach } from 'bun:test';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ConvexReactClient } from 'convex/react';
import { UrlInputModal } from './UrlInputModal';
import { ConvexAppProvider } from '../lib/convex';
import type { ArticleData } from '../types';

// The component now calls the Convex `extract` action through
// useCRPC()/useMutation() instead of a plain fetch to the old extraction
// route. Rather than mocking an ES module (bun:test's mock.module()
// persists process-wide and would leak into other test files sharing this
// process), stub the one real network boundary directly:
// ConvexReactClient#action is what the generated mutationFn ultimately
// calls. Save/restore it per test, exactly like the existing global.fetch
// stubbing pattern elsewhere in this repo.
const originalAction = ConvexReactClient.prototype.action;

afterEach(() => {
  ConvexReactClient.prototype.action = originalAction;
  cleanup();
});

function stubExtractAction(impl: () => Promise<ArticleData>) {
  ConvexReactClient.prototype.action = (async () => impl()) as typeof originalAction;
}

function renderModal(props: Partial<Parameters<typeof UrlInputModal>[0]> = {}) {
  const onClose = props.onClose ?? (() => {});
  const onLoadArticle = props.onLoadArticle ?? (() => {});
  return render(
    <ConvexAppProvider>
      <UrlInputModal
        isOpen={true}
        onClose={onClose}
        onLoadArticle={onLoadArticle}
        onAddToQueue={props.onAddToQueue}
      />
    </ConvexAppProvider>
  );
}

test('submitting a URL calls the Convex extract mutation and loads the result', async () => {
  const extracted: ArticleData = {
    title: 'A Real Article',
    author: 'Jane Doe',
    content: 'Extracted body content.',
    sourceUrl: 'https://example.com/article',
    sourceType: 'article',
  };
  stubExtractAction(async () => extracted);

  let loaded: ArticleData | null = null;
  let closed = false;
  const { container } = renderModal({
    onLoadArticle: (article) => {
      loaded = article;
    },
    onClose: () => {
      closed = true;
    },
  });

  const urlInput = container.querySelector('input[type="url"]') as HTMLInputElement;
  fireEvent.change(urlInput, { target: { value: 'https://example.com/article' } });

  const narrateButton = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Narrate now')
  ) as HTMLButtonElement;
  fireEvent.click(narrateButton);

  await waitFor(() => {
    expect(loaded).not.toBeNull();
  });

  expect(loaded!).toEqual(extracted);
  expect(closed).toBe(true);
});

test('a failing extraction shows the error state instead of throwing', async () => {
  stubExtractAction(async () => {
    throw new Error('Extraction failed');
  });

  let loadArticleCalled = false;
  const { container } = renderModal({
    onLoadArticle: () => {
      loadArticleCalled = true;
    },
  });

  const urlInput = container.querySelector('input[type="url"]') as HTMLInputElement;
  fireEvent.change(urlInput, { target: { value: 'https://example.com/bad' } });

  const narrateButton = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Narrate now')
  ) as HTMLButtonElement;

  expect(() => fireEvent.click(narrateButton)).not.toThrow();

  await waitFor(() => {
    expect(container.textContent).toContain('Extraction failed');
  });

  expect(loadArticleCalled).toBe(false);
});
