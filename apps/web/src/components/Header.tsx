import React, { useState } from 'react';
import { PlusCircle, ChevronLeft, Ellipsis } from 'lucide-react';
import { useReaderChrome } from './ReaderFrame';
import type { ArticleData } from '../types';
import type { UserProfile } from './AuthScreen';
import { buildShareLink } from '../utils/shareLink';

interface HeaderProps {
  article: ArticleData | null;
  onOpenSettings: () => void;
  onOpenInput: () => void;
  onOpenLibrary?: () => void;
  user?: UserProfile | null;
  onOpenAuth?: () => void;
  remainingSeconds?: number;
  onToggleViewMode?: () => void;
  viewMode?: 'kinetic' | 'full';
}

export function Header({
  article,
  onOpenSettings,
  onOpenInput,
  onOpenLibrary,
  user,
  onOpenAuth,
  remainingSeconds = 0,
  onToggleViewMode,
  viewMode = 'kinetic',
}: HeaderProps) {
  const visible = useReaderChrome();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    if (typeof window === 'undefined') return;

    // Articles with a source get the kinreader.com/r/<id> share page (OG card,
    // then a forward into the reader); pasted text has nothing a recipient
    // could open, so the current app link is the best available.
    let shareUrl = window.location.href;
    if (article?.sourceUrl) {
      shareUrl =
        buildShareLink(article) ??
        (() => {
          const u = new URL(window.location.origin);
          u.searchParams.set('url', article.sourceUrl!);
          return u.toString();
        })();
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const input = document.createElement('textarea');
        input.value = shareUrl;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };
  const remaining = Math.max(0, Math.ceil(remainingSeconds));
  return (
    <header className="reader-header">
      <button className="reader-icon reader-back reader-fading" onClick={onOpenLibrary}
        title="Library & Queue" inert={!visible}><ChevronLeft size={18} /></button>
      <div className="reader-meta">
        <span className="reader-author">{article?.author || 'Kinreader'}</span><span>·</span>
        <span className="reader-title">{article?.title}</span><span className="reader-title-dot">·</span>
        <span className="reader-remaining">{remaining < 60 ? `${remaining}s left` : `${Math.ceil(remaining / 60)} min left`}</span>
      </div>
      <div className="reader-actions reader-fading" inert={!visible}>
        <button className="reader-icon" onClick={onOpenInput} title="Add Article or URL"><PlusCircle size={18} /></button>
        <button className="reader-icon" onClick={() => setMenuOpen(!menuOpen)} title="More options"
          aria-expanded={menuOpen} aria-haspopup="menu"><Ellipsis size={18} /></button>
        {menuOpen && <>
          <button className="reader-menu-dismiss" aria-label="Close options" onClick={() => setMenuOpen(false)} />
          <div className="reader-menu" role="menu" data-reader-menu onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setMenuOpen(false); } }}>
            <button role="menuitem" onClick={handleShare} title={copied ? 'Link copied!' : 'Share article link'}>{copied ? 'Link copied!' : 'Share link'}</button>
            {article?.sourceUrl && <a role="menuitem" href={article.sourceUrl} target="_blank" rel="noopener noreferrer">Open source</a>}
            <button role="menuitem" onClick={() => { onToggleViewMode?.(); setMenuOpen(false); }}>{viewMode === 'kinetic' ? 'Full text' : 'Kinetic'}</button>
            <button role="menuitem" title="Preferences" onClick={() => { onOpenSettings(); setMenuOpen(false); }}>Settings</button>
            <button role="menuitem" onClick={() => { onOpenAuth?.(); setMenuOpen(false); }}>{user ? 'Account' : 'Sign In'}</button>
          </div>
        </>}
      </div>
    </header>
  );
}
