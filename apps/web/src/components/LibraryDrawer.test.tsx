import { test, expect } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import { LibraryDrawer, type SavedArticleItem } from './LibraryDrawer';
import type { ArticleData } from '../types';

const article: ArticleData = {
  title: 'Test Article',
  content: 'Some article content',
  sourceUrl: 'https://example.com/article-1',
  sourceType: 'article',
};

const savedArticles: SavedArticleItem[] = [
  {
    id: article.sourceUrl!,
    article,
    progress: 42,
    lastReadAt: Date.now(),
  },
];

// Regression test for plan 001: the mobile mini-player renders a `<Pause>`
// icon from lucide-react when isPlaying is true. Before plan 001 fixed the
// missing import, mounting with isPlaying={true} and at least one saved
// article (so the mini-player is shown) threw
// `ReferenceError: Pause is not defined` in production.
test('renders with isPlaying=true and an open drawer without throwing', () => {
  let container: ReturnType<typeof render> | undefined;

  expect(() => {
    container = render(
      <LibraryDrawer
        isOpen={true}
        onClose={() => {}}
        savedArticles={savedArticles}
        onSelectArticle={() => {}}
        isPlaying={true}
      />
    );
  }).not.toThrow();

  // Confirm it actually mounted content (not a silent no-op render).
  expect(container?.container.textContent).toContain('Test Article');

  cleanup();
});
