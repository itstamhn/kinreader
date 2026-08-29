import type { APIContext } from 'astro';
import { renderOgCard, type OgCardParams } from '../../lib/og-card';
import { renderOgCardPng } from '../../lib/og-card-png';

// Reads query parameters at request time, so it cannot be prerendered.
export const prerender = false;

export async function GET({ url }: APIContext): Promise<Response> {
  const params: OgCardParams = {
    title: url.searchParams.get('title'),
    author: url.searchParams.get('author'),
    snippet: url.searchParams.get('snippet'),
    image: url.searchParams.get('image'),
  };

  try {
    const png = await renderOgCardPng(params);
    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    // The PNG path has real moving parts -- wasm, embedded fonts, a network
    // fetch -- and this route is only ever hit by a crawler. Falling back to
    // the old SVG keeps the card imperfect rather than absent; a 500 here
    // means no preview at all, which is strictly worse than the bug this
    // renderer was written to fix.
    console.error('OG PNG render failed, serving the SVG fallback:', err);
    return new Response(renderOgCard(params), {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }
}
