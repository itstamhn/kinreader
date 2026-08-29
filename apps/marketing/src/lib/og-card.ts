// The OG card, moved verbatim from the Worker (apps/web/src/server.ts) when
// Astro took over the apex origin. The artwork is unchanged on purpose: plan
// 014 was a move, not a redesign.
//
// KNOWN LIMITATION, inherited: this is an SVG, and X and Facebook do not render
// SVG for og:image / twitter:image, so the card almost certainly does not appear
// on any social platform today. Re-rendering it as a PNG (satori + resvg, or
// astro-og-canvas) is a follow-up plan -- see plans/README.md.
//
// It lives here rather than in the route file so it can be tested directly:
// anything under src/pages is a route, and Astro would try to prerender a test
// file sitting next to the endpoint.
import { escapeHtml, safeImageUrl } from './escape';

export interface OgCardParams {
  title?: string | null;
  author?: string | null;
  snippet?: string | null;
  image?: string | null;
}

// resvg has no text layout engine beyond a single line, and SVG <text> does not
// wrap. Measuring properly would mean shaping the string, so this approximates:
// Newsreader at 42px averages a bit under half its size per character, which
// puts ~30 characters in the 610px column. Titles are already truncated above,
// so the worst case is a slightly short line, never an overflow.
const HEADLINE_CHARS_PER_LINE = 30;
const HEADLINE_MAX_LINES = 3;

export function wrapHeadline(
  text: string,
  charsPerLine: number = HEADLINE_CHARS_PER_LINE,
  maxLines: number = HEADLINE_MAX_LINES
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    // `!current` keeps a single word longer than the line from being dropped;
    // it overhangs slightly, which beats losing it.
    if (candidate.length <= charsPerLine || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  if (lines.length === 0) return [''];
  if (lines.length <= maxLines) return lines;

  // More lines than the box holds: keep what fits and ellipsize the last one.
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, charsPerLine - 3)).trimEnd()}...`;
  return kept;
}

export function renderOgCard(params: OgCardParams): string {
  const title = params.title || 'We are in the middle of the digital renaissance';
  const author = params.author || 'DAN KOE';
  const snippet = params.snippet || title;
  const image = params.image || '';

  // 90, not the 70 this card used when the headline was a single wrapped block:
  // the box now holds three lines of ~30 characters, and cutting at 70 threw
  // away a word that had somewhere to go.
  const cleanTitle = escapeHtml(title.length > 90 ? title.slice(0, 87) + '...' : title);
  const cleanSnippet = escapeHtml(snippet.length > 55 ? snippet.slice(0, 52) + '...' : snippet);
  const cleanAuthor = escapeHtml(author.toUpperCase());
  // A data: URI here comes from the PNG renderer, which has already fetched and
  // validated the remote image; anything else is a raw query parameter and goes
  // through the http(s)-only guard.
  const imageHref = image.startsWith('data:image/') ? image : safeImageUrl(image);
  const titleLines = wrapHeadline(cleanTitle);

  const svg = `
  <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <!-- Dark Purple Ambient Background Gradient -->
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0a0a10"/>
        <stop offset="50%" stop-color="#140a24"/>
        <stop offset="100%" stop-color="#07070d"/>
      </linearGradient>

      <radialGradient id="glow" cx="20%" cy="30%" r="70%">
        <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
      </radialGradient>

      <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#1e1b4b" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="#0f0e17" stop-opacity="0.9"/>
      </linearGradient>

      <linearGradient id="pillGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#8b5cf6"/>
        <stop offset="100%" stop-color="#6366f1"/>
      </linearGradient>

      <clipPath id="cardClip">
        <rect x="40" y="40" width="1120" height="550" rx="32" ry="32"/>
      </clipPath>

      <clipPath id="imgClip">
        <rect x="740" y="110" width="370" height="410" rx="24" ry="24"/>
      </clipPath>
    </defs>

    <!-- Background Canvas -->
    <rect width="1200" height="630" fill="url(#bg)"/>
    <rect width="1200" height="630" fill="url(#glow)"/>

    <!-- Inner Glass Card Container -->
    <g clip-path="url(#cardClip)">
      <rect x="40" y="40" width="1120" height="550" rx="32" ry="32" fill="url(#cardGrad)" stroke="#312e81" stroke-width="2"/>

      <!-- Brand Header -->
      <circle cx="90" cy="95" r="9" fill="#10b981" />
      <circle cx="90" cy="95" r="16" fill="none" stroke="#10b981" stroke-opacity="0.4" stroke-width="2"/>
      <text x="115" y="102" font-family="Instrument Sans" font-size="24" font-weight="800" fill="#ffffff" letter-spacing="-0.5">kinreader<tspan fill="#a78bfa">.com</tspan></text>
      <text x="1110" y="100" text-anchor="end" font-family="Instrument Sans" font-size="14" font-weight="700" fill="#9ca3af" letter-spacing="2">MADE TO LISTEN</text>

      <!-- Full Article Pill -->
      <rect x="90" y="150" width="130" height="32" rx="16" fill="#065f46" fill-opacity="0.4" stroke="#10b981" stroke-width="1.5"/>
      <circle cx="108" cy="166" r="4" fill="#34d399"/>
      <text x="120" y="171" font-family="Instrument Sans" font-size="12" font-weight="800" fill="#6ee7b7" letter-spacing="1.5">FULL ARTICLE</text>

      <!-- Article Headline -->
      <text x="90" y="238" font-family="Newsreader" font-size="42" font-weight="700" fill="#ffffff" letter-spacing="-0.5">${titleLines
        .map((line, i) => `<tspan x="90" dy="${i === 0 ? 0 : 52}">${line}</tspan>`)
        .join('')}</text>

      <!-- Author Tag -->
      <text x="90" y="420" font-family="Instrument Sans" font-size="16" font-weight="600" fill="#9ca3af" letter-spacing="1">by <tspan fill="#e5e7eb" font-weight="800">${cleanAuthor}</tspan></text>

      <!-- Action / Hear it out loud Pill -->
      <rect x="90" y="455" width="220" height="52" rx="26" fill="url(#pillGrad)" filter="drop-shadow(0 8px 16px rgba(139,92,246,0.3))"/>
      <polygon points="122,473 122,491 138,482" fill="#ffffff"/>
      <text x="148" y="487" font-family="Instrument Sans" font-size="16" font-weight="700" fill="#ffffff" letter-spacing="0.5">Hear it out loud</text>

      <!-- Bottom Kinetic Bar Indicator -->
      <rect x="90" y="525" width="610" height="30" rx="8" fill="#000000" fill-opacity="0.4"/>
      <text x="105" y="546" font-family="Instrument Sans" font-size="14" font-weight="600" fill="#ffffff">${cleanSnippet}</text>

      <!-- Right Side Diagram / Cover Image -->
      <rect x="740" y="140" width="370" height="380" rx="24" fill="#0d0d14" stroke="#4338ca" stroke-width="2"/>
      ${imageHref ? `<image href="${imageHref}" x="740" y="140" width="370" height="380" preserveAspectRatio="xMidYMid slice" clip-path="url(#imgClip)"/>` : `
        <rect x="740" y="140" width="370" height="380" rx="24" fill="#181825"/>
        <text x="925" y="322" text-anchor="middle" font-family="Instrument Sans" font-size="30" font-weight="700" fill="#ffffff">kinreader</text>
        <text x="925" y="352" text-anchor="middle" font-family="Instrument Sans" font-size="13" font-weight="700" fill="#6b7280" letter-spacing="2">MADE TO LISTEN</text>
      `}
    </g>
  </svg>
  `;

  return svg;
}
