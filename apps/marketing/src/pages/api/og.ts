import type { APIContext } from 'astro';
import { renderOgCard } from '../../lib/og-card';

// Reads query parameters at request time, so it cannot be prerendered.
export const prerender = false;

export function GET({ url }: APIContext): Response {
  const svg = renderOgCard({
    title: url.searchParams.get('title'),
    author: url.searchParams.get('author'),
    snippet: url.searchParams.get('snippet'),
    image: url.searchParams.get('image'),
  });

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
