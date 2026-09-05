import { assertPublicHttpUrl } from '@kinreader/backend/articleUrl';
import { useRef, useState } from 'react';
import type { ArticleData } from '../types';
import { readListeningValue, writeListeningValue } from '../utils/listeningSession';
export interface CreationInput { sourceUrl?: string; content?: string; title?: string }
interface Intent { input: CreationInput; ownerToken: string }

// All input screens hand off to this controller. Retain uncertain submissions so
// a lost mutation response or reload retries the same ID instead of paying twice.
export function useArticleCreation(create: (input: CreationInput & { ownerToken: string }) => Promise<string>, saved: (article: ArticleData) => void) {
  const activeInput = useRef<CreationInput | null>(null);
  const active = useRef<Promise<ArticleData> | null>(null);
  const [pending, setPending] = useState<Intent | null>(() => readListeningValue('creation', null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (input: CreationInput): Promise<ArticleData> => {
    if (active.current) {
      if (JSON.stringify(activeInput.current) === JSON.stringify(input)) return active.current;
      const message = 'Another article is still being saved. Wait for confirmation before submitting this article.';
      setError(message); return Promise.reject(new Error(message));
    }
    const stored = readListeningValue<Intent | null>('creation', pending);
    if (stored && JSON.stringify(stored.input) !== JSON.stringify(input)) {
      const message = 'Your previous article has not been confirmed. Use Retry creation to recover it before starting another article.';
      setPending(stored); setError(message); return Promise.reject(new Error(message));
    }
    const validationError = validateCreationInput(input);
    if (validationError) { setError(validationError); return Promise.reject(new Error(validationError)); }
    activeInput.current = input;
    const intent = stored || { input, ownerToken: crypto.randomUUID() };
    writeListeningValue('creation', intent); setPending(intent); setBusy(true); setError(null);
    const promise = create({ ...input, ownerToken: intent.ownerToken }).then(recordingId => {
      writeListeningValue(`owner_${recordingId}`, intent.ownerToken);
      const article: ArticleData = { ...input, recordingId, content: input.content || '', title: input.title || (input.sourceUrl ? new URL(input.sourceUrl).hostname : 'Pasted text'), stage: input.content ? 'preparing' : 'finding' };
      saved(article); writeListeningValue('creation', null); setPending(null);
      return article;
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'Could not confirm creation. Retry safely using the same request.');
      throw cause;
    }).finally(() => { active.current = null; setBusy(false); });
    active.current = promise;
    return promise;
  };
  return { submit, busy, error, pending, retry: () => pending ? submit(pending.input) : Promise.resolve(null) };
}

// Validate before keeping a retry token, so definite input errors cannot trap an unresolved request.
export function validateCreationInput(input: CreationInput): string | null {
  if ((input.title?.length || 0) > 500) return 'Use a title of 500 characters or fewer.';
  if ((input.content?.length || 0) > 150000) return 'Paste 150,000 characters or fewer.';
  if (input.sourceUrl) {
    if (input.sourceUrl.length > 2048) return 'Use a link of 2,048 characters or fewer.';
    try {
      const url = assertPublicHttpUrl(input.sourceUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return 'Enter a valid website link.';
    } catch { return 'Enter a valid public website link.'; }
  }
  if (!input.sourceUrl && !input.content?.trim()) return 'Paste a website link or some article text.';
  return null;
}
