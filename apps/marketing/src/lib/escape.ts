// Moved from apps/web/src/server.ts with the routes that use them (plan 014).
// Astro escapes interpolated expressions in .astro templates, so the share page
// no longer needs escapeHtml -- but the OG endpoint builds an SVG string by
// hand, where nothing escapes for us. `safeImageUrl` is load-bearing in both:
// it is what rejects a `javascript:` URL (plan 004).

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeImageUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return escapeHtml(parsed.toString());
  } catch {
    return '';
  }
}
