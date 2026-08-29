import { test, expect } from 'bun:test';

// `bun test` cannot import a .astro file -- rendering one needs Astro's own
// pipeline. So the share page's escaping was verified end to end against a dev
// server instead (recorded in plans/README.md), and what is guarded here are
// the two properties that a future edit could silently break.
const SHARE_PAGE = `${import.meta.dir}/../src/pages/r/[id].astro`;

test('the share page never uses set:html', async () => {
  const source = await Bun.file(SHARE_PAGE).text();

  // Astro escapes interpolated expressions by default, which is the only reason
  // this page is safe with attacker-controlled query parameters. The directive
  // opts out of exactly that, and would reintroduce the XSS plan 004 closed.
  // Matched as an attribute (`set:html=`) so the page's own warning comment
  // about not using it does not trip this test.
  expect(source).not.toMatch(/set:html\s*=/);
});

test('the share page redirects to the app origin, not back to the apex', async () => {
  const source = await Bun.file(SHARE_PAGE).text();

  // The share page lives on kinreader.com and the reader does not. A relative
  // redirect here would land back on the marketing site and loop forever, and
  // it would do it only in production, where the two are different origins.
  expect(source).toContain('https://app.kinreader.com/?read=');
  expect(source).not.toMatch(/content=\{`0;url=\/[^/]/);
});
