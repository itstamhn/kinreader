import { v } from 'convex/values';
import { action, mutation, query } from '../_generated/server';

export async function extractArticle(url: string, monidApiKey?: string) {
  const isTwitter = /twitter\.com|x\.com|fxtwitter\.com|fixupx\.com/i.test(url);
  let title = 'Article';
  let content = '';
  let author = isTwitter ? 'X Post' : 'Article';
  let authorHandle = '';
  let authorAvatar = '';
  let image: string | undefined = undefined;

  // 0. Dedicated X / Twitter Article Extractor
  const xMatch = url.match(/(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com)\/([a-zA-Z0-9_]+)\/status\/([0-9]+)/i);
  if (xMatch) {
    const username = xMatch[1];
    const statusId = xMatch[2];
    try {
      const fxRes = await fetch(`https://api.fxtwitter.com/${username}/status/${statusId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });
      if (fxRes.ok) {
        const fxData = (await fxRes.json()) as any;
        const tweet = fxData?.tweet;
        if (tweet) {
          author = tweet.author?.name ? `${tweet.author.name}` : `${username} on X`;
          authorHandle = `@${tweet.author?.screen_name || username}`;
          authorAvatar = tweet.author?.avatar_url || `https://unavatar.io/x/${username}`;

          if (tweet.article?.content?.blocks && Array.isArray(tweet.article.content.blocks)) {
            title = tweet.article.title || tweet.text || 'X Article';
            content = tweet.article.content.blocks
              .map((b: any) => b.text)
              .filter(Boolean)
              .join('\n\n');
            image = tweet.article.cover_media?.media_info?.original_img_url ||
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
      console.warn('fxTwitter error:', err);
    }
  }

  // 1. Monid TinyFish /fetch
  const activeMonidKey = monidApiKey || (typeof process !== 'undefined' ? process.env.MONID_API_KEY : undefined);
  if (!content && activeMonidKey) {
    try {
      const monidRunRes = await fetch('https://api.monid.ai/v1/run', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${activeMonidKey}`,
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
        }
      }
    } catch (err) {
      console.warn('Monid TinyFish error:', err);
    }
  }

  // 2. Direct HTML / Jina Reader Fallback
  if (!content) {
    try {
      const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
      const jinaRes = await fetch(jinaUrl, {
        headers: { 'Accept': 'application/json', 'X-Return-Format': 'markdown' },
      });
      if (jinaRes.ok) {
        const jinaData = (await jinaRes.json()) as any;
        if (jinaData?.data) {
          title = jinaData.data.title || title;
          content = jinaData.data.content || '';
          if (!image) image = jinaData.data.image;
          if (jinaData.data.author) author = jinaData.data.author;
        }
      }
    } catch (e) {
      console.warn('Jina fallback error:', e);
    }
  }

  const cleanContent = (content || 'No readable text could be extracted from this page.')
    .replace(/^Post\s+Log\s+in.*?Post\s+.*?Dissecting/i, 'Dissecting')
    .replace(/^Post\s+Log\s+in[^\n]*?(\b[A-Z])/i, '$1')
    .replace(/\d+:\d+\s+[AP]M\s+·\s+.*?Views$/i, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\*\#\_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const wordsCount = cleanContent.split(/\s+/).filter(Boolean).length;

  return {
    url,
    title: title || 'Extracted Article',
    content: cleanContent,
    author: author || 'Web Article',
    authorHandle: authorHandle || undefined,
    authorAvatar: authorAvatar || (authorHandle ? `https://unavatar.io/x/${authorHandle.replace('@', '')}` : undefined),
    image: image || undefined,
    sourceType: (isTwitter ? 'x' : 'article') as 'x' | 'article',
    wordCount: wordsCount,
    createdAt: Date.now(),
  };
}
