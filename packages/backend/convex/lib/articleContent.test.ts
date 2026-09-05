import { test, expect } from 'bun:test';
import { assessArticle, boundCapturedText, cleanArticleText, extractHtml } from './articleContent';
import { snapshot } from './ingestion';
test('main text excludes sidebar articles and keeps paragraphs and code punctuation', () => {
  const html = '<aside><article><p>Wrong related story</p></article></aside><main><p>C# uses user_id.</p><p>A second paragraph &amp; facts.</p></main>';
  expect(extractHtml(html).content).toBe('C# uses user_id.\n\nA second paragraph & facts.');
  expect(cleanArticleText('## Heading\n\nC# uses user_id.')).toBe('Heading\n\nC# uses user_id.');
});
test('gates cannot become audio and brief uncertain articles require review', () => {
  expect(assessArticle('Sign in to continue. '.repeat(10))).toBe('blocked');
  expect(assessArticle('This short article might only be an introductory paragraph with the rest missing.')).toBe('review');
  expect(assessArticle('Hi!', true)).toBe('readable');
});
test('non whitespace languages count real content', () => {
  expect(assessArticle('這是一篇關於閱讀與學習的文章。'.repeat(15))).toBe('readable');
});
test('captured and spoken Unicode snapshots stay below the document budget', () => {
  const result = snapshot('🦊漢字'.repeat(60000));
  expect(result.truncated).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(700000);
  expect(result.content).not.toContain('\uFFFD');
  expect(boundCapturedText('Hello\n\nworld').text).toBe('Hello\n\nworld');
});
