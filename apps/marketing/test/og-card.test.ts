import { test, expect } from 'bun:test';
import { renderOgCard } from '../src/lib/og-card';

// The card is the one thing on this site that builds markup by hand, with no
// framework escaping behind it -- which is why these tests moved here from
// apps/web/src/server.test.ts along with the route (plans 004, 014).

test('renderOgCard escapes a <script> payload in the title', () => {
  const svg = renderOgCard({ title: '<script>alert(1)</script>' });
  expect(svg).not.toContain('<script>');
  expect(svg).toContain('&lt;script&gt;');
});

test('renderOgCard escapes an attribute-breaking payload in the author', () => {
  const svg = renderOgCard({ author: 'Bob" onload="evil()' });
  expect(svg).not.toContain('onload="evil()"');
  expect(svg).toContain('&quot;');
});

test('renderOgCard rejects a javascript: image URL and falls back to the placeholder', () => {
  const svg = renderOgCard({ title: 'Test', image: 'javascript:alert(1)' });
  expect(svg).not.toContain('javascript:');
  expect(svg).toContain('<rect x="740"');
});

test('renderOgCard rejects a data: image URL', () => {
  const svg = renderOgCard({ title: 'Test', image: 'data:text/html,<script>alert(1)</script>' });
  expect(svg).not.toContain('data:text/html');
});

test('renderOgCard allows a legitimate https image URL through as an href', () => {
  const svg = renderOgCard({ title: 'Test', image: 'https://example.com/a.png' });
  expect(svg).toContain('https://example.com/a.png');
});

test('renderOgCard truncates an overlong title rather than overflowing the card', () => {
  const svg = renderOgCard({ title: 'x'.repeat(200) });
  expect(svg).toContain('...');

  // The headline box holds three lines of ~30 characters, so the cap is 90 --
  // asserting a fixed substring length would just re-pin the test to whatever
  // the constant happens to be. Assert the emitted text instead.
  const headline = svg.match(/<tspan x="90"[^>]*>([^<]*)<\/tspan>/)?.[1] ?? '';
  expect(headline.length).toBeLessThanOrEqual(90);
  expect(headline.endsWith('...')).toBe(true);
});

test('renderOgCard renders an ordinary title as readable text', () => {
  const svg = renderOgCard({ title: 'Hello World', author: 'Dan Koe' });
  expect(svg).toContain('Hello World');
  expect(svg).toContain('DAN KOE');
});

test('renderOgCard escapes an apostrophe without double-escaping ampersands', () => {
  const svg = renderOgCard({ title: "Dan's Article & More" });
  expect(svg).toContain('&#39;');
  expect(svg).toContain('&amp;');
  expect(svg).not.toContain('&amp;amp;');
});
