import { ArticleCreationForm } from './ArticleCreationForm';
import type { CreationInput } from '../../hooks/useArticleCreation';
import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, Lock, X } from 'lucide-react';
import type { ArticleData } from '../../types';
import { authClient } from '../../lib/auth-client';
import { buildShareLink } from '../../utils/shareLink';

export const formatListeningTime = (seconds: number) => {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

export function ListeningSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const touch = useRef<number | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="listening-scrim" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="listening-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
        if (e.key === 'Tab') {
          const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]') ?? []);
          const first = nodes[0], last = nodes.at(-1);
          if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="listening-sheet-handle" onTouchStart={e => { touch.current = e.touches[0]?.clientY ?? null; }}
        onTouchEnd={e => { if (touch.current !== null && (e.changedTouches[0]?.clientY ?? 0) - touch.current > 55) onClose(); touch.current = null; }}><span /></div>
      <button className="listening-sheet-close" aria-label="Close dialog" onClick={onClose}><X size={18} /></button>
      <h2 id={titleId}>{title}</h2>{children}
    </div>
  </div>;
}

export function SaveListeningSheet({ currentTime, callbackURL, onClose, sendMagicLink = input => (authClient.signIn as any).magicLink(input) }: {
  currentTime: number; callbackURL: () => string; onClose: () => void;
  sendMagicLink?: (input: { email: string; name: string; callbackURL: string }) => Promise<{ error?: { message?: string } | null }>;
}) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await sendMagicLink({ email: email.trim(), name: email.trim().split('@')[0] || 'Reader', callbackURL: callbackURL() });
      if (result?.error) throw new Error(result.error.message || 'Could not send the sign-in link. Try again.');
      setSent(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not send the sign-in link. Try again.'); }
    finally { setBusy(false); }
  };
  return <ListeningSheet title={sent ? 'Check your inbox' : 'Keep this for later'} onClose={onClose}>
    {sent ? <>
      <p>We sent a sign-in link to <strong>{email}</strong>. Open it on any device. This tab keeps playing.</p>
      <div className="listening-sheet-links"><button disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Resend'}</button><button disabled={busy} onClick={() => { setSent(false); setError(''); }}>Use a different email</button></div>
    </> : <>
      <p>We’ll save the article and hold your place, <span className="listening-position">{formatListeningTime(currentTime)}</span>, so you can pick it up on any device.</p>
      <form onSubmit={send} className="listening-form listening-save-form">
        <label className="sr-only" htmlFor="save-email">Email address</label>
        <input id="save-email" type="email" autoComplete="email" required placeholder="you@email.com" value={email} onChange={e => setEmail(e.target.value)} />
        <button className="listening-primary" disabled={busy} aria-label={busy ? 'Sending…' : 'Email me a sign-in link'}>{busy ? 'Sending…' : <><span className="listening-mobile-only">Email me a sign-in link</span><span className="listening-desktop-only">Email me a link</span></>}</button>
      </form>
    </>}
    {error && <p className="listening-error" role="alert">{error}</p>}
    <div className="listening-save-footer">
      {!sent && <p className="listening-helper"><span className="listening-mobile-only">No password. The audio keeps playing while you check your inbox.</span><span className="listening-desktop-only">No password. The audio keeps playing.</span></p>}
      <button className="listening-dismiss" onClick={onClose} aria-label="Not now, keep listening"><span className="listening-mobile-only">Not now, keep listening</span><span className="listening-desktop-only">Not now</span></button>
    </div>
  </ListeningSheet>;
}

export function ShareListeningSheet({ article, duration, visibility, canManage, onApply, onClose }: {
  article: ArticleData; duration: number; visibility: 'private' | 'link'; canManage: boolean;
  onApply: (visibility: 'private' | 'link') => Promise<string | null>; onClose: () => void;
}) {
  const [selected, setSelected] = useState(visibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [manualLink, setManualLink] = useState('');
  const apply = async () => {
    setBusy(true); setError(''); setCopied(false);
    try {
      const link = await onApply(selected);
      if (!link) { onClose(); return; }
      try { await navigator.clipboard.writeText(link); setCopied(true); }
      catch { setManualLink(link); }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update sharing. Try again.'); }
    finally { setBusy(false); }
  };
  return <ListeningSheet title="Who can listen?" onClose={onClose}>
    <fieldset className="listening-visibility" disabled={busy || !canManage}><legend className="sr-only">Recording visibility</legend>
      {(['private', 'link'] as const).map(value => <label key={value} data-selected={selected === value}>
        <input type="radio" name="visibility" checked={selected === value} onChange={() => { setSelected(value); setCopied(false); setManualLink(''); }} />
        <span><strong>{value === 'private' ? 'Private' : 'Anyone with the link'}</strong><small>{value === 'private' ? 'Only you can access this recording.' : 'Anyone you send this link to can listen.'}</small></span>
      </label>)}
    </fieldset>
    {!canManage && <p className="listening-helper">This recording was shared with you. Its creator controls access.</p>}
    <span className="listening-eyebrow">They will see</span>
    <div className="listening-share-preview"><span className="listening-preview-play" aria-hidden="true">▶</span><div><h3>{article.title}</h3><p>{article.author || 'Unknown author'} · AI narration{duration > 0 ? ` · ${Math.max(1, Math.round(duration / 60))} min` : ''}</p></div></div>
    <p>Your notes and listening progress stay private.</p>
    {error && <p className="listening-error" role="alert">{error}</p>}
    <div className="listening-share-link-row listening-form" data-link={selected === 'link'} data-manual={!!manualLink}>
      {selected === 'link' && <input className="listening-share-link" aria-label="Listening link" value={manualLink || buildShareLink(article) || ''} readOnly onFocus={e => e.target.select()} />}
      <button className="listening-primary" disabled={busy} aria-label={busy ? 'Saving…' : selected === 'private' ? 'Done' : copied ? 'Link copied' : 'Copy link'} onClick={() => void apply()}>{busy ? 'Saving…' : selected === 'private' ? 'Done' : copied ? 'Link copied' : <><span className="listening-mobile-only">Copy link</span><span className="listening-desktop-only">Copy</span></>}</button>
    </div>
    {copied && <span className="sr-only" role="status">Listening link copied</span>}
    <p className="listening-helper">Sharing a link does not add this recording to public collections.</p>
  </ListeningSheet>;
}

export function CreateListening({ isPlaying, remainingSeconds, onBack, onCreate }: {
  isPlaying: boolean; remainingSeconds: number; onBack: () => void; onCreate: (input: CreationInput) => void;
}) {
  return <section className="listening-create">
    <header className="listening-top"><div className="listening-create-back"><button className="listening-icon" onClick={onBack} aria-label="Back to listening"><ChevronLeft size={18} /></button><span>{isPlaying ? `Still playing · ${Math.max(1, Math.ceil(remainingSeconds / 60))} min left` : ''}</span></div><span className="listening-wordmark listening-desktop-only">Kinetic Reader</span></header>
    <div className="listening-create-body"><h1>What would you like to listen to?</h1><ArticleCreationForm onCreate={onCreate} layout="page" /><p className="listening-privacy"><Lock size={14} /><span>Added to your private library. You choose whether to share it.</span></p></div>
    <p className="listening-create-footer">Works with most articles, essays and newsletters.<br className="listening-mobile-only" /> Preparation time depends on the article’s length.</p>
  </section>;
}
