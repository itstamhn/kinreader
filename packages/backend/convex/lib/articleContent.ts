import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';

export function cleanArticleText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// With the separately stored speech representation this stays below Convex's 1 MB document limit, even for CJK/emoji.
export function boundCapturedText(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bounded = bytes.length > 300_000 ? new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 300_000)).replace(/\uFFFD$/, '') : text;
  if (bounded.length > 150_000) bounded = bounded.slice(0, 150_000).replace(/[\uD800-\uDBFF]$/, '');
  return { text: bounded, truncated: bounded.length !== text.length };
}

export function assessArticle(text: string, verifiedPost = false): 'readable' | 'review' | 'blocked' {
  if (!text.trim()) return 'blocked';
  const gate = /(?:sign in|log in|subscribe) to (?:continue|read|access)|enable javascript|checking your browser|verify you are human|access denied|just a moment|accept (?:all )?cookies/i;
  const words = Math.max(text.split(/\s+/).length, (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu)?.length || 0) / 2);
  if (gate.test(text) && words < 100) return 'blocked';
  if (verifiedPost) return 'readable';
  if (words < 8) return 'blocked';
  if (words < 40 || gate.test(text)) return 'review';
  return 'readable';
}

export function extractHtml(html: string) {
  const root = parse(html);
  const candidates: Tree.Element[] = [];
  let title = '', author = '', image: string | undefined;
  const attrs = (node: Tree.Element) => Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
  const ignored = new Set(['script', 'style', 'svg', 'nav', 'footer', 'aside', 'form', 'button', 'noscript', 'head']);
  const blocks = new Set(['p', 'div', 'section', 'article', 'main', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'pre', 'br']);
  function text(node: Tree.Node): string {
    if ('value' in node) return node.value;
    if (!('childNodes' in node)) return '';
    if ('tagName' in node) {
      const a = attrs(node);
      if (ignored.has(node.tagName) || a['aria-hidden'] === 'true' || 'hidden' in a || /(?:^|[-_\s])(cookie|sidebar|navigation|paywall|advert|related|share-tools)(?:$|[-_\s])/i.test(`${a.class || ''} ${a.id || ''}`)) return '';
      const content = node.childNodes.map(text).join('');
      return blocks.has(node.tagName) ? `\n\n${content}\n\n` : content;
    }
    return node.childNodes.map(text).join('');
  }
  function walk(node: Tree.Node) {
    if ('tagName' in node) {
      const a = attrs(node);
      if (['aside', 'nav', 'footer'].includes(node.tagName) || /(?:cookie|sidebar|related|advert)/i.test(`${a.class || ''} ${a.id || ''}`)) return;
      if (node.tagName === 'meta') {
        const key = a.property || a.name;
        if (key === 'og:title' || key === 'twitter:title') title = a.content || title;
        if (key === 'author') author = a.content || '';
        if (key === 'og:image') image = a.content;
      }
      if (node.tagName === 'title' && !title) title = node.childNodes.map(text).join('');
      if (['article', 'main', 'body'].includes(node.tagName) || a.role === 'main') candidates.push(node);
    }
    if ('childNodes' in node) node.childNodes.forEach(walk);
  }
  walk(root);
  // Prefer a real article container. Body is a fallback and still has to pass the content checks.
  const ranked = candidates.map(node => ({ content: cleanArticleText(text(node)), priority: node.tagName === 'article' ? 2 : node.tagName === 'body' ? 0 : 1 }))
    .filter(c => c.content.length > 0).sort((a, b) => b.priority - a.priority || b.content.length - a.content.length);
  return { title: title.trim(), author: author.trim(), image, content: ranked[0]?.content || '', hasArticleContainer: (ranked[0]?.priority || 0) > 0 };
}
