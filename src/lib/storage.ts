import type { ArticleData } from '../types';
import type { SavedArticleItem } from '../components/LibraryDrawer';
import { SAMPLE_ARTICLE } from '../data/sampleData';

const ARTICLES_STORAGE_KEY = 'kinetic_saved_articles_v2';
const CLIENT_ID_KEY = 'kinreader_client_id';

// 1. Get all saved articles
export function getSavedArticles(): SavedArticleItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(ARTICLES_STORAGE_KEY);
    if (!raw) {
      // Default with initial sample article
      const initial: SavedArticleItem[] = [
        {
          id: 'sample_article_default',
          article: SAMPLE_ARTICLE,
          progress: 0,
          lastReadAt: Date.now(),
          isCachedAudio: true,
        },
      ];
      localStorage.setItem(ARTICLES_STORAGE_KEY, JSON.stringify(initial));
      return initial;
    }
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// 2. Save / Upsert an article
export function saveArticleToLibrary(article: ArticleData, progress: number = 0): SavedArticleItem[] {
  const current = getSavedArticles();
  const id = article.sourceUrl || article.title;
  const existingIdx = current.findIndex((item) => item.id === id || item.article.title === article.title);

  const updatedItem: SavedArticleItem = {
    id,
    article,
    progress,
    lastReadAt: Date.now(),
    isCachedAudio: hasCachedAudio(id),
  };

  let next: SavedArticleItem[];
  if (existingIdx !== -1) {
    next = [...current];
    next[existingIdx] = {
      ...next[existingIdx]!,
      ...updatedItem,
      progress: progress > 0 ? progress : next[existingIdx]!.progress,
    };
  } else {
    next = [updatedItem, ...current];
  }

  try {
    localStorage.setItem(ARTICLES_STORAGE_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('LocalStorage full, trimming oldest articles', e);
  }
  return next;
}

// 3. Delete an article
export function deleteArticleFromLibrary(id: string): SavedArticleItem[] {
  const current = getSavedArticles();
  const next = current.filter((item) => item.id !== id && item.article.title !== id);
  try {
    localStorage.setItem(ARTICLES_STORAGE_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

// 4. Check if audio is cached. The sample article ships with a bundled
// audio asset; every other article's audio is now cached server-side in
// Convex (convex/routers/tts.ts, plan 007) rather than in sessionStorage,
// so there is no client-side cache left to inspect here.
export function hasCachedAudio(articleId: string): boolean {
  return articleId === SAMPLE_ARTICLE.title || articleId === SAMPLE_ARTICLE.sourceUrl;
}

// 5. A stable per-browser id, persisted in localStorage. There is no
// per-user identity until plan 008 lands auth, so this is the "stable
// client identifier" the TTS action's rate limiter
// (convex/lib/rateLimiter.ts) keys on until then.
export function getOrCreateClientId(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return 'anonymous';
  }
}
