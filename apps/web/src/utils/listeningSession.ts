import type { ArticleData } from '../types';
import { encodeShareId } from './shareLink';
const PREFIX = 'kinreader_listening_';
export function readListeningValue<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) || 'null') ?? fallback; } catch { return fallback; }
}
export function writeListeningValue(key: string, value: unknown) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* Keep this listening session usable without storage. */ }
}
export const listeningKey = (article: ArticleData) => article.recordingId || article.sourceUrl || article.title;
export const recordingOwnerToken = (id?: string): string | undefined => id ? readListeningValue<string | undefined>(`owner_${id}`, undefined) : undefined;
export function listeningCallbackURL(article: ArticleData, seconds: number, wordIndex: number) {
  const url = new URL('/', window.location.origin);
  const id = article.recordingId ? `p_${article.recordingId}` : article.sourceUrl ? encodeShareId(article.sourceUrl) : null;
  if (id) url.searchParams.set('read', id);
  else url.searchParams.set('listen', '1');
  url.searchParams.set('t', String(Math.max(0, Math.floor(seconds))));
  url.searchParams.set('w', String(Math.max(0, wordIndex)));
  url.searchParams.set('save', '1');
  const token = recordingOwnerToken(article.recordingId);
  if (token) url.hash = new URLSearchParams({ claim: token }).toString();
  writeListeningValue('pendingSave', { key: listeningKey(article), seconds, wordIndex });
  return url.href;
}
