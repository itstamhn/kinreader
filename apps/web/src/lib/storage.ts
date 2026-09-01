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

export function articleLibraryId(article: ArticleData): string {
  return article.sourceUrl || article.title;
}

function writeSavedArticles(next: SavedArticleItem[]): void {
  try {
    localStorage.setItem(ARTICLES_STORAGE_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('LocalStorage full, trimming oldest articles', e);
  }
}

// 2. Save / Upsert an article. Re-saving an article that is already in the
// library keeps the reading position it had -- opening it again is not a
// reason to forget where the listener was.
export function saveArticleToLibrary(article: ArticleData, progress: number = 0): SavedArticleItem[] {
  const current = getSavedArticles();
  const id = articleLibraryId(article);
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
    const existing = current[existingIdx]!;
    next = [...current];
    next[existingIdx] = {
      ...existing,
      ...updatedItem,
      progress: progress > 0 ? progress : existing.progress,
      lastWordIndex: existing.lastWordIndex,
    };
  } else {
    next = [updatedItem, ...current];
  }

  writeSavedArticles(next);
  return next;
}

// 2b. Record where the listener is in an article, so the library's
// "Continue" actually continues (locally for everyone; the cloud copy in
// `userArticles` is written by App.tsx for signed-in readers).
export function updateArticleProgress(
  id: string,
  update: { progress: number; lastWordIndex: number }
): SavedArticleItem[] {
  const current = getSavedArticles();
  const index = current.findIndex((item) => item.id === id || item.article.title === id);
  if (index === -1) return current;
  const next = [...current];
  next[index] = {
    ...next[index]!,
    progress: Math.max(0, Math.min(100, update.progress)),
    lastWordIndex: Math.max(0, Math.floor(update.lastWordIndex)),
    lastReadAt: Date.now(),
  };
  writeSavedArticles(next);
  return next;
}

// The word to resume from for a saved item, or 0 when the article should
// start over: nothing recorded, barely started, or already finished.
export const RESUME_MIN_WORD_INDEX = 3;
export const RESUME_COMPLETED_PROGRESS = 98;

export function resumeWordIndexFor(
  item: { progress?: number; lastWordIndex?: number } | null | undefined
): number {
  if (!item) return 0;
  const index = item.lastWordIndex ?? 0;
  if (!Number.isFinite(index) || index < RESUME_MIN_WORD_INDEX) return 0;
  if ((item.progress ?? 0) >= RESUME_COMPLETED_PROGRESS) return 0;
  return Math.floor(index);
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
