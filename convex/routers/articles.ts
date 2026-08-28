import { z } from 'zod';
import { action } from '../crpc';

// Convex values are capped at 1MB. Truncate well below that so JSON framing,
// title/author fields, etc. never push the response over the limit.
const MAX_CONTENT_CHARS = 900_000;

// Guards against SSRF: rejects anything that isn't a plain http(s) URL
// pointing at a public host, before any fetch in the extraction chain runs
// (including the Jina Reader fallback, which also receives the raw URL as a
// path segment). This is a hostname deny-list, not a full SSRF defence -- see
// the maintenance notes in plans/011-validate-extract-urls.md for its known
// limitations (no DNS resolution check, redirects not re-validated).
function assertPublicHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }

  const host = parsed.hostname.toLowerCase();

  // Reject obvious local / private / link-local targets by name.
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('URL host is not permitted');
  }

  // Reject literal IPs in private, loopback, and link-local ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      throw new Error('URL host is not permitted');
    }
  }

  // IPv6 loopback / unique-local / link-local, including v4-mapped forms.
  if (host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '');
    if (h === '::1' || h === '::' || /^f[cd]/i.test(h) || /^fe80:/i.test(h) || h.includes('127.0.0.1')) {
      throw new Error('URL host is not permitted');
    }
  }

  return parsed;
}

interface FxTwitterTweet {
  author?: { name?: string; screen_name?: string; avatar_url?: string };
  text?: string;
  article?: {
    title?: string;
    content?: { blocks?: Array<{ text?: string }> };
    cover_media?: { media_info?: { original_img_url?: string } };
    media_entities?: Array<{ media_info?: { original_img_url?: string } }>;
  };
  media?: { photos?: Array<{ url?: string }> };
}

// Ported from src/server.ts's `POST /api/extract` handler (the live behaviour
// of record, including its direct-HTML fallback). Keep the two in sync only
// in the direction of this file being the single source of truth going
// forward — the Spiceflow route is removed in the same change that lands this.
export const extract = action
  .input(z.object({ url: z.string().min(1) }))
  .action(async ({ input }) => {
    const url = assertPublicHttpUrl(input.url.trim()).toString();

    const isTwitter = /twitter\.com|x\.com|fxtwitter\.com|fixupx\.com/i.test(url);

    let title = 'Article';
    let content = '';
    let author = isTwitter ? 'X Post' : 'Article';
    let authorHandle = '';
    let authorAvatar = '';
    let image: string | undefined;

    const monidApiKey = process.env.MONID_API_KEY;

    // 0. Dedicated X / Twitter Article & Tweet Extractor
    const xMatch = url.match(
      /(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com)\/([a-zA-Z0-9_]+)\/status\/([0-9]+)/i
    );
    if (xMatch) {
      const username = xMatch[1];
      const statusId = xMatch[2];
      try {
        const fxRes = await fetch(`https://api.fxtwitter.com/${username}/status/${statusId}`, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          },
        });
        if (fxRes.ok) {
          const fxData = (await fxRes.json()) as { tweet?: FxTwitterTweet };
          const tweet = fxData?.tweet;
          if (tweet) {
            author = tweet.author?.name ? `${tweet.author.name}` : `${username} on X`;
            authorHandle = `@${tweet.author?.screen_name || username}`;
            authorAvatar = tweet.author?.avatar_url || `https://unavatar.io/x/${username}`;

            // Handle Long-Form X Articles (e.g. Jacob Posel, Dan Koe articles)
            if (tweet.article?.content?.blocks && Array.isArray(tweet.article.content.blocks)) {
              title = tweet.article.title || tweet.text || 'X Article';
              content = tweet.article.content.blocks
                .map((b) => b.text)
                .filter(Boolean)
                .join('\n\n');
              image =
                tweet.article.cover_media?.media_info?.original_img_url ||
                tweet.article.media_entities?.[0]?.media_info?.original_img_url ||
                tweet.media?.photos?.[0]?.url;
            } else {
              title = tweet.text ? tweet.text.slice(0, 90) : 'X Post';
              content = tweet.text || '';
              image = tweet.media?.photos?.[0]?.url;
            }
          }
        }
      } catch (err) {
        console.warn('fxTwitter API extraction error', err);
      }
    }

    // 1. PRIMARY: Monid TinyFish /fetch (Free, fast real-browser markdown extraction)
    if (!content && monidApiKey) {
      try {
        const monidRunRes = await fetch('https://api.monid.ai/v1/run', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${monidApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            provider: 'tinyfish',
            endpoint: '/fetch',
            input: { body: { urls: [url], format: 'markdown' } },
          }),
        });

        if (monidRunRes.ok) {
          const runData = (await monidRunRes.json()) as any;
          if (runData.status === 'COMPLETED' && runData.output?.results?.[0]) {
            const res = runData.output.results[0];
            title = res.title || title;
            content = res.text || '';
            if (res.author) author = res.author;
          } else if (runData.runId) {
            // Quick poll (max 3s)
            for (let i = 0; i < 3; i++) {
              await new Promise((r) => setTimeout(r, 800));
              const pollRes = await fetch(`https://api.monid.ai/v1/runs/${runData.runId}`, {
                headers: { 'Authorization': `Bearer ${monidApiKey}` },
              });
              if (pollRes.ok) {
                const pollData = (await pollRes.json()) as any;
                if (pollData.status === 'COMPLETED' && pollData.output?.results?.[0]) {
                  const polled = pollData.output.results[0];
                  title = polled.title || title;
                  content = polled.text || '';
                  if (polled.author) author = polled.author;
                  break;
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn('Monid TinyFish fetch error, falling back to direct parser', err);
      }
    }

    // 2. Fallback: Direct HTML parser for OpenGraph metadata & clean text extraction
    if (!content) {
      try {
        const rawRes = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        if (rawRes.ok) {
          const html = await rawRes.text();

          // Extract OG Metadata
          const ogTitleMatch = html.match(
            /<meta\s+(?:property|name)=["'](?:og:title|twitter:title)["']\s+content=["']([^"']+)["']/i
          );
          const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          const ogTitle = ogTitleMatch?.[1];
          const pageTitle = titleTagMatch?.[1];
          if (ogTitle) title = ogTitle.trim();
          else if (pageTitle) title = pageTitle.trim();

          const ogImageMatch = html.match(
            /<meta\s+(?:property|name)=["'](?:og:image|twitter:image)["']\s+content=["']([^"']+)["']/i
          );
          const ogImage = ogImageMatch?.[1];
          if (ogImage) image = ogImage.trim();

          const ogAuthorMatch = html.match(
            /<meta\s+(?:property|name)=["'](?:author|twitter:creator)["']\s+content=["']([^"']+)["']/i
          );
          const ogAuthor = ogAuthorMatch?.[1];
          if (ogAuthor) author = ogAuthor.trim();

          // Clean body content
          const cleanedBody = html
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ')
            .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();

          if (cleanedBody.length > 50) {
            content = cleanedBody;
          }
        }
      } catch (e) {
        console.warn('Direct fetch failed, falling back to reader proxy', e);
      }
    }

    // 3. Fallback: Jina Reader API
    if (!content) {
      try {
        const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
        const jinaRes = await fetch(jinaUrl, {
          headers: {
            'Accept': 'application/json',
            'X-Return-Format': 'markdown',
          },
        });
        if (jinaRes.ok) {
          const jinaData = (await jinaRes.json().catch(() => null)) as any;
          if (jinaData?.data) {
            title = jinaData.data.title || title;
            content = jinaData.data.content || '';
            if (!image) image = jinaData.data.image;
            if (jinaData.data.author) author = jinaData.data.author;
          }
        }
      } catch (e) {
        console.warn('Jina fetch failed', e);
      }
    }

    if (isTwitter) {
      const match = url.match(/(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/);
      if (match) {
        authorHandle = `@${match[1]}`;
        author = `${match[1]} on X`;
        authorAvatar = `https://unavatar.io/x/${match[1]}`;
      }
    }

    let cleanContent = (content || 'No readable text could be extracted from this page.')
      .replace(/^Post\s+Log\s+in.*?Post\s+.*?Dissecting/i, 'Dissecting')
      .replace(/^Post\s+Log\s+in[^\n]*?(\b[A-Z])/i, '$1')
      .replace(/\d+:\d+\s+[AP]M\s+·\s+.*?Views$/i, '')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\*\#\_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    let truncated = false;
    if (cleanContent.length > MAX_CONTENT_CHARS) {
      cleanContent = cleanContent.slice(0, MAX_CONTENT_CHARS);
      truncated = true;
    }

    return {
      title: title || 'Extracted Article',
      content: cleanContent,
      author: author || 'Web Article',
      authorHandle: authorHandle || undefined,
      authorAvatar:
        authorAvatar || (authorHandle ? `https://unavatar.io/x/${authorHandle.replace('@', '')}` : undefined),
      image,
      sourceUrl: url,
      sourceType: (isTwitter ? 'x' : 'article') as 'x' | 'article',
      truncated,
    };
  });
