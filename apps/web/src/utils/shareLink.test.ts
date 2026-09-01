import { test, expect } from 'bun:test';
import { buildShareLink, decodeShareId, encodeShareId } from './shareLink';

test('a source URL round-trips through the share id', () => {
  const url = 'https://paulgraham.com/lesson.html?ref=kin&x=1#top';
  const id = encodeShareId(url)!;
  expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeShareId(id)).toBe(url);
});

test('non-http sources and garbage ids are refused', () => {
  expect(encodeShareId('javascript:alert(1)')).toBeNull();
  expect(encodeShareId('not a url')).toBeNull();
  expect(decodeShareId('!!!')).toBeNull();
  expect(decodeShareId('')).toBeNull();
  // Valid base64url that decodes to a non-URL.
  expect(decodeShareId(btoa('hello world').replaceAll('=', ''))).toBeNull();
  // Valid base64url that decodes to a disallowed scheme.
  expect(decodeShareId(btoa('file:///etc/passwd').replaceAll('=', ''))).toBeNull();
});

test('the share link targets the marketing share page with escaped card parameters', () => {
  const link = buildShareLink({
    sourceUrl: 'https://example.com/a?b=c',
    title: 'A "quoted" <title>',
    author: 'Jane & Co',
    image: 'https://img.example/cover.png',
  })!;
  const parsed = new URL(link);
  expect(parsed.origin).toBe('https://kinreader.com');
  expect(parsed.pathname.startsWith('/r/')).toBe(true);
  expect(decodeShareId(parsed.pathname.slice(3))).toBe('https://example.com/a?b=c');
  expect(parsed.searchParams.get('t')).toBe('A "quoted" <title>');
  expect(parsed.searchParams.get('a')).toBe('Jane & Co');
  expect(parsed.searchParams.get('img')).toBe('https://img.example/cover.png');
});

test('pasted text with no source URL has no share link, and http images are dropped', () => {
  expect(buildShareLink({ title: 'Notes', sourceUrl: undefined })).toBeNull();
  const link = buildShareLink({ sourceUrl: 'https://example.com', title: 'T', image: 'http://insecure/x.png' })!;
  expect(new URL(link).searchParams.get('img')).toBeNull();
});
