import type { ArticleData, WordTiming } from '../types';
import type { SavedArticleItem } from '../components/LibraryDrawer';
import { SAMPLE_ARTICLE, SAMPLE_TIMINGS, SAMPLE_DURATION } from '../data/sampleData';

const ARTICLES_STORAGE_KEY = 'kinetic_saved_articles_v2';
const AUDIO_CACHE_PREFIX = 'kinetic_audio_cache_';

export interface CachedAudioData {
  audioBase64: string;
  words: WordTiming[];
  duration: number;
  voice: string;
  speed: number;
}

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

// 4. Cache generated audio & timestamps
export function cacheArticleAudio(
  articleId: string,
  audioBase64: string,
  words: WordTiming[],
  duration: number,
  voice: string = 'Adrian',
  speed: number = 1.0
) {
  if (typeof window === 'undefined') return;
  const cacheKey = `${AUDIO_CACHE_PREFIX}${articleId}_${voice}_${speed}`;
  const data: CachedAudioData = {
    audioBase64,
    words,
    duration,
    voice,
    speed,
  };
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify(data));
  } catch (e) {
    console.warn('SessionStorage cache full', e);
  }
}

// 5. Retrieve cached audio
export function getCachedArticleAudio(
  articleId: string,
  voice: string = 'Adrian',
  speed: number = 1.0
): CachedAudioData | null {
  if (typeof window === 'undefined') return null;
  const cacheKey = `${AUDIO_CACHE_PREFIX}${articleId}_${voice}_${speed}`;
  try {
    const raw = sessionStorage.getItem(cacheKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// 6. Check if audio is cached
export function hasCachedAudio(articleId: string, voice: string = 'Adrian', speed: number = 1.0): boolean {
  if (articleId === SAMPLE_ARTICLE.title || articleId === SAMPLE_ARTICLE.sourceUrl) return true;
  return Boolean(getCachedArticleAudio(articleId, voice, speed));
}
