import React, { useEffect, useId, useRef, useState } from 'react';
import { validateCreationInput, type CreationInput } from '../../hooks/useArticleCreation';

export function ArticleCreationForm({ onCreate, initialUrl = '', layout = 'embedded' }: { onCreate: (input: CreationInput) => void; initialUrl?: string; layout?: 'embedded' | 'page' }) {
  const inputId = useId();
  const urlInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState(initialUrl);
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const validUrl = (() => {
    try {
      const parsed = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
      return !parsed.username && !parsed.password && parsed.hostname.includes('.') && !validateCreationInput({ sourceUrl: parsed.href });
    } catch { return false; }
  })();
  useEffect(() => {
    if (layout !== 'page') return;
    const paste = (event: ClipboardEvent) => {
      if (!window.matchMedia('(min-width: 640px)').matches || (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"], [role="dialog"]'))) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      setMode('url'); setUrl(text.trim()); setError(''); urlInput.current?.focus();
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [layout]);
  const pasteLink = async () => {
    try { setUrl((await navigator.clipboard.readText()).trim()); setError(''); urlInput.current?.focus(); }
    catch { setError('Paste the article link into the field using your keyboard or touch menu.'); }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (mode === 'text') {
      const input = { content, title: title.trim() || undefined };
      const error = validateCreationInput(input);
      if (error) setError(error); else onCreate(input);
      return;
    }
    try {
      const parsed = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
      if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) throw new Error();
      const input = { sourceUrl: parsed.href };
      const error = validateCreationInput(input);
      if (error) setError(error); else onCreate(input);
    } catch { setError('Enter a website link, such as https://example.com/article.'); }
  };
  return <form className="listening-form article-creation-form" data-layout={layout} data-mode={mode} onSubmit={submit}>
    {layout !== 'page' && <div className="listening-sheet-links"><button type="button" aria-pressed={mode === 'url'} onClick={() => setMode('url')}>Website link</button><button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Paste text</button></div>}
    {mode === 'url' ? <>
      {layout === 'page' && <label className="listening-url-label" htmlFor={inputId}>Paste an article link</label>}
      <div className={layout === 'page' ? 'listening-url-field' : 'creation-url-input'}>
        <input id={inputId} ref={urlInput} aria-label="Article link" placeholder={layout === 'page' ? 'https://' : 'example.com/article'} value={url} onChange={event => { setUrl(event.target.value); setError(''); }} autoFocus />
        {layout === 'page' && <><button type="button" className="listening-mobile-only" onClick={() => void pasteLink()}>Paste</button><kbd className="listening-desktop-only" aria-hidden="true">⌘V</kbd></>}
      </div>
    </> : <>
      <input aria-label="Title" placeholder="Title (optional)" maxLength={500} value={title} onChange={event => setTitle(event.target.value)} />
      <textarea aria-label="Article text" placeholder="Paste the article text…" rows={8} value={content} onChange={event => setContent(event.target.value)} />
    </>}
    {error && <p className="listening-error" role="alert">{error}</p>}
    <button className="listening-primary" disabled={mode === 'url' ? layout === 'page' ? !validUrl : !url.trim() : !content.trim()}>Create audio</button>
    {layout !== 'page' && <p className="listening-helper">Your private recording is saved before preparation starts. You can leave and return later.</p>}
  </form>;
}
