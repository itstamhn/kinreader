import { test, expect } from 'bun:test';
import { escapeHtml, safeImageUrl } from '../src/lib/escape';

// These moved here from apps/web/src/server.test.ts with the routes that use
// them (plan 014). The OG endpoint builds an SVG by hand, so nothing escapes
// for it -- these functions are the whole defence (plan 004).

test('escapeHtml neutralises a </title><script> payload', () => {
  const out = escapeHtml('</title><script>alert(1)</script>');
  expect(out).not.toContain('<script>');
  expect(out).toContain('&lt;script&gt;');
});

test('escapeHtml neutralises an attribute-breaking payload', () => {
  const out = escapeHtml('Bob" onload="evil()');
  expect(out).not.toContain('"');
  expect(out).toContain('&quot;');
});

test('escapeHtml escapes apostrophes and does not double-escape ampersands', () => {
  expect(escapeHtml("O'Brien")).toBe('O&#39;Brien');
  // & must be replaced first, or the entities emitted above get re-escaped.
  expect(escapeHtml('a & b')).toBe('a &amp; b');
  expect(escapeHtml('<')).toBe('&lt;');
});

test('safeImageUrl rejects a javascript: URL', () => {
  expect(safeImageUrl('javascript:alert(1)')).toBe('');
  expect(safeImageUrl('JaVaScRiPt:alert(1)')).toBe('');
});

test('safeImageUrl rejects a data: URL and unparseable input', () => {
  expect(safeImageUrl('data:text/html,<script>alert(1)</script>')).toBe('');
  expect(safeImageUrl('not a url')).toBe('');
  expect(safeImageUrl('')).toBe('');
});

test('safeImageUrl allows a legitimate https URL through', () => {
  expect(safeImageUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
});
