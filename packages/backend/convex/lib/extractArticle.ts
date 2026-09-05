import { assertPublicHttpUrl } from './articleUrl';
import { extractHtml, cleanArticleText, assessArticle, boundCapturedText } from './articleContent';
const FETCH_TIMEOUT_MS = { fxtwitter: 8000, monid: 10000, monidPoll: 5000, direct: 12000, jina: 15000 };

// Bound upstream bodies before parsing. Provider timeouts bound the whole chain to about a minute.
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 3_000_000) throw new Error('Page is too large to retrieve'); chunks.push(value); } }
  finally { await reader.cancel(); }
  const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
}
async function readJson(response: Response): Promise<any> { return JSON.parse(await readBounded(response)); }

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

export async function extractArticle(rawUrl: string) {
    const parsedUrl = assertPublicHttpUrl(rawUrl.trim());
    const url = parsedUrl.toString();
    const isTwitter = /^(?:www\.)?(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com)$/i.test(parsedUrl.hostname);

    let title = 'Article';
    let content = '';
    let author = isTwitter ? 'X Post' : 'Article';
    let authorHandle = '';
    let authorAvatar = '';
    let image: string | undefined;

    let accepted = false;
    let verifiedPost = false;
    let weakContainer = false;
    let uncertain: { title: string; content: string; author: string; image?: string } | undefined;
    const consider = () => {
      if (accepted) return;
      if (typeof content !== 'string' || !content) { content = ''; return; }
      content = cleanArticleText(content);
      let quality = assessArticle(content, verifiedPost);
      if (weakContainer && quality === 'readable') quality = 'review';
      if (quality === 'readable') { accepted = true; return; }
      if (quality === 'review' && (!uncertain || content.length > uncertain.content.length)) uncertain = { title, content, author, image };
      content = '';
    };
    const monidApiKey = process.env.MONID_API_KEY;

    // 0. Dedicated X / Twitter Article & Tweet Extractor
    const xMatch = isTwitter ? parsedUrl.pathname.match(/^\/([a-zA-Z0-9_]+)\/status\/([0-9]+)(?:\/|$)/) : null;
    if (xMatch) {
      const username = xMatch[1];
      const statusId = xMatch[2];
      try {
        const fxRes = await fetch(`https://api.fxtwitter.com/${username}/status/${statusId}`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.fxtwitter),
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          },
        });
        if (fxRes.ok) {
          const fxData = (await readJson(fxRes)) as { tweet?: FxTwitterTweet };
          const tweet = fxData?.tweet;
          if (tweet) {
            verifiedPost = true;
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

    consider();
    verifiedPost = false;

    // Try the configured browser-based extractor before the direct HTML fallback.
    if (!content && monidApiKey) {
      try {
        const monidRunRes = await fetch('https://api.monid.ai/v1/run', {
          method: 'POST',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.monid),
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
          const runData = (await readJson(monidRunRes)) as any;
          if (runData.status === 'COMPLETED' && runData.output?.results?.[0]) {
            const res = runData.output.results[0];
            title = res.title || title;
            content = res.text || '';
            if (res.author) author = res.author;
          } else if (runData.runId) {
            // Three bounded polls; unfinished provider work falls through.
            for (let i = 0; i < 3; i++) {
              await new Promise((r) => setTimeout(r, 800));
              const pollRes = await fetch(`https://api.monid.ai/v1/runs/${runData.runId}`, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.monidPoll),
                headers: { 'Authorization': `Bearer ${monidApiKey}` },
              });
              if (pollRes.ok) {
                const pollData = (await readJson(pollRes)) as any;
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

    consider();

    // 2. Fallback: Direct HTML parser for OpenGraph metadata & clean text extraction
    if (!content) {
      try {
        const rawRes = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.direct),
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        if (rawRes.ok) {
          const html = await readBounded(rawRes);

          const extracted = extractHtml(html);
          title = extracted.title || title;
          author = extracted.author || author;
          image = extracted.image || image;
          content = extracted.content;
          weakContainer = !extracted.hasArticleContainer;

        }
      } catch (e) {
        console.warn('Direct fetch failed, falling back to reader proxy', e);
      }
    }

    consider();

    weakContainer = false;
    // 3. Fallback: Jina Reader API
    if (!content) {
      try {
        const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
        const jinaRes = await fetch(jinaUrl, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS.jina),
          headers: {
            'Accept': 'application/json',
            'X-Return-Format': 'markdown',
          },
        });
        if (jinaRes.ok) {
          const jinaData = (await readJson(jinaRes).catch(() => null)) as any;
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

    consider();
    if (!accepted && uncertain) {
      ({ title, content, author, image } = uncertain);
    }
    if (!content) throw new Error('No readable article was found. The page may require a login. Try again or paste the article text.');
    const bounded = boundCapturedText(content);
    const cleanContent = bounded.text;
    const truncated = bounded.truncated;
    return {
      title: typeof title === 'string' && title.trim() ? title.slice(0, 500) : 'Extracted Article',
      content: cleanContent,
      author: typeof author === 'string' && author.trim() ? author.slice(0, 500) : 'Web Article',
      authorHandle: authorHandle || undefined,
      authorAvatar:
        authorAvatar || (authorHandle ? `https://unavatar.io/x/${authorHandle.replace('@', '')}` : undefined),
      image: typeof image === 'string' && /^https?:\/\//i.test(image) ? image.slice(0, 2048) : undefined,
      sourceUrl: url,
      sourceType: (isTwitter ? 'x' : 'article') as 'x' | 'article',
      truncated,
      needsReview: !accepted,
      reviewReason: !accepted ? 'This may be a partial article. Check the text before creating audio.' : undefined,
    };
}
