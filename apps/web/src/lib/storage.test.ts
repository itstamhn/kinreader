import { test, expect, beforeEach } from 'bun:test';
import { saveArticleToLibrary, getSavedArticles, deleteArticleFromLibrary } from './storage';
import type { ArticleData } from '../types';

beforeEach(() => {
  localStorage.clear();
});

function makeArticle(overrides: Partial<ArticleData> = {}): ArticleData {
  return {
    title: 'Test Article',
    content: 'Some article content',
    sourceUrl: 'https://example.com/article-1',
    sourceType: 'article',
    ...overrides,
  };
}

test('saving an article returns it in getSavedArticles()', () => {
  const article = makeArticle();
  saveArticleToLibrary(article);

  const saved = getSavedArticles();
  const found = saved.find((item) => item.article.sourceUrl === article.sourceUrl);

  expect(found).toBeDefined();
  expect(found?.article.title).toBe('Test Article');
  expect(found?.id).toBe(article.sourceUrl);
});

test('saving the same sourceUrl twice updates rather than duplicates', () => {
  const article = makeArticle();
  saveArticleToLibrary(article, 10);
  saveArticleToLibrary({ ...article, title: 'Updated Title' }, 20);

  const saved = getSavedArticles();
  const matches = saved.filter((item) => item.id === article.sourceUrl);

  expect(matches.length).toBe(1);
  expect(matches[0]?.article.title).toBe('Updated Title');
  expect(matches[0]?.progress).toBe(20);
});

test('delete removes the article from the library', () => {
  const article = makeArticle();
  saveArticleToLibrary(article);
  expect(getSavedArticles().some((item) => item.id === article.sourceUrl)).toBe(true);

  const remaining = deleteArticleFromLibrary(article.sourceUrl!);

  expect(remaining.some((item) => item.id === article.sourceUrl)).toBe(false);
  expect(getSavedArticles().some((item) => item.id === article.sourceUrl)).toBe(false);
});

import { updateArticleProgress, resumeWordIndexFor, articleLibraryId } from './storage';

test('updateArticleProgress records the position and saveArticleToLibrary keeps it', () => {
  localStorage.clear();
  const article = { title: 'Resume me', content: 'one two three four five six', sourceUrl: 'https://example.com/resume' };
  saveArticleToLibrary(article);
  updateArticleProgress(articleLibraryId(article), { progress: 40, lastWordIndex: 4 });

  let item = getSavedArticles().find((entry) => entry.id === article.sourceUrl)!;
  expect(item.progress).toBe(40);
  expect(item.lastWordIndex).toBe(4);

  // Re-opening the article (which re-saves it) must not forget the position.
  saveArticleToLibrary(article);
  item = getSavedArticles().find((entry) => entry.id === article.sourceUrl)!;
  expect(item.progress).toBe(40);
  expect(item.lastWordIndex).toBe(4);
});

test('resumeWordIndexFor starts over for fresh, barely started, or finished articles', () => {
  expect(resumeWordIndexFor(undefined)).toBe(0);
  expect(resumeWordIndexFor({ progress: 0, lastWordIndex: 0 })).toBe(0);
  expect(resumeWordIndexFor({ progress: 1, lastWordIndex: 2 })).toBe(0);
  expect(resumeWordIndexFor({ progress: 99, lastWordIndex: 400 })).toBe(0);
  expect(resumeWordIndexFor({ progress: 40, lastWordIndex: 57 })).toBe(57);
});
