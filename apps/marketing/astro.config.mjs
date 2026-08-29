// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// `site` has to be absolute: canonical URLs, the sitemap and the RSS feed are
// all built from it, and the OG tags on the share pages are consumed by
// crawlers that never resolve a relative URL.
export default defineConfig({
  site: 'https://kinreader.com',
  // Static by default -- the landing page and the blog are prerendered. The two
  // routes that read query parameters at request time (`/r/:id`, `/api/og`)
  // opt out individually with `export const prerender = false`.
  output: 'static',
  adapter: cloudflare(),
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
});
