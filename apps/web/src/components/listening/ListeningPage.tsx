import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Book, Bookmark, Check, Ellipsis, Share, Text, UserRound } from 'lucide-react';
import type { ArticleData, WordTiming } from '../../types';
import { KineticDisplay } from '../KineticDisplay';
import { LoadingRing } from '../LoadingRing';
import { formatListeningTime as time } from './ListeningSheets';

export type PreparationState = 'finding' | 'preparing' | 'loadingSaved' | 'partial' | 'complete' | 'extractFailed' | 'audioFailed' | 'needsReview' | 'cancelled';
export interface ListeningPlayback {
  words: WordTiming[]; currentWordIndex: number; currentTime: number; duration: number;
  isPlaying: boolean; rate: number; progress: number; bufferedSeconds: number;
}
export interface ListeningPageProps {
  article: ArticleData; playback: ListeningPlayback; prepState: PreparationState; saved: boolean; signedIn: boolean;
  onPlay: () => void; onSeek: (percent: number) => void; onSpeed: (speed: number) => void; onWord: (index: number, startPlayback?: boolean) => void;
  onSave: () => void; onShare: () => void; onCreate: () => void; onLibrary: () => void; onAuth: () => void; onRetry: () => void;
  canManage?: boolean; onApprove?: () => void; onReplace?: (content: string) => void; onCancel?: () => void;
  toast?: string | null; notice?: string | null;
  theme?: 'dark' | 'light'; accountName?: string; avatarUrl?: string;
}
const speeds = [0.8, 1, 1.2, 1.5, 1.8, 2, 2.5, 3, 3.5];

export function ListeningPage({ article, playback: p, prepState: state, saved, signedIn, onPlay, onSeek, onSpeed, onWord, onSave, onShare, onCreate, onLibrary, onAuth, onRetry, canManage = false, onApprove, onReplace, onCancel, toast, notice, theme = 'dark', accountName, avatarUrl }: ListeningPageProps) {
  const [replacement, setReplacement] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [follow, setFollow] = useState(false);
  const [fullText, setFullText] = useState(false);
  const [menu, setMenu] = useState<'more' | 'speed' | null>(null);
  const [hint, setHint] = useState(false);
  useEffect(() => { if (!p.isPlaying) setFollow(false); }, [p.isPlaying]);
  useEffect(() => { setFollow(false); setFullText(false); setMenu(null); }, [article.sourceUrl, article.recordingId]);
  const finding = state === 'finding', extractFailed = state === 'extractFailed', audioFailed = state === 'audioFailed';
  const needsReview = state === 'needsReview', cancelled = state === 'cancelled';
  const loadingSaved = state === 'loadingSaved';
  const unavailable = needsReview || cancelled || finding || loadingSaved || state === 'preparing' || extractFailed || audioFailed;
  const partial = state === 'partial';
  const estimated = finding || state === 'preparing' || partial;
  const safeRate = Math.max(0.1, p.rate);
  const duration = p.duration / safeRate;
  const source = (() => { try { const u = new URL(article.sourceUrl || ''); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } })();
  const author = finding || extractFailed ? (() => { try { return new URL(source || '').hostname.replace(/^www\./, ''); } catch { return 'Article'; } })() : article.author || 'Unknown author';
  const durationLabel = finding || extractFailed || audioFailed ? null : partial
    ? `${time(p.bufferedSeconds / safeRate)} ready` : `${estimated ? 'about ' : ''}${Math.max(1, Math.round(duration / 60))} min`;
  const immersive = follow && p.isPlaying && !audioFailed && !fullText;
  const toggle = () => {
    if (unavailable) return;
    if (!p.isPlaying) {
      setFollow(!window.matchMedia('(min-width: 640px)').matches);
      try { if (!localStorage.getItem('kinreader_listening_hint')) { setHint(true); localStorage.setItem('kinreader_listening_hint', '1'); } } catch {}
    }
    onPlay();
  };
  const skip = (seconds: number) => { if (p.duration > 0) onSeek(Math.max(0, Math.min(100, (p.currentTime + seconds * safeRate) / p.duration * 100))); };
  const seek = (clientX: number, element: HTMLDivElement) => {
    const box = element.getBoundingClientRect();
    if (box.width > 0) onSeek(Math.max(0, Math.min(100, (clientX - box.left) / box.width * 100)));
  };
  const playButton = (ghost = false) => <button className={ghost ? 'reader-ghost-pause' : 'reader-play'} disabled={unavailable} onClick={toggle} aria-label={p.isPlaying ? 'Pause' : 'Play'}>
    {p.isPlaying ? <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true"><rect x="3" y="2" width="5.5" height="22" rx="2.2" fill="currentColor" /><rect x="13.5" y="2" width="5.5" height="22" rx="2.2" fill="currentColor" /></svg> : <svg width="22" height="24" viewBox="0 0 12 14" aria-hidden="true"><path d="M2 2v10c0 .8.9 1.3 1.6.9l8-5c.6-.4.6-1.4 0-1.8l-8-5C2.9.7 2 1.2 2 2z" fill="currentColor" /></svg>}
  </button>;
  const skipButton = (direction: number) => <button className="reader-skip" disabled={unavailable} onClick={() => skip(direction * 15)} aria-label={direction < 0 ? 'Rewind 15 seconds' : 'Fast forward 15 seconds'}>
    <svg width="26" height="26" viewBox="0 0 30 30" fill="none" style={{ transform: direction > 0 ? 'scaleX(-1)' : undefined }} aria-hidden="true"><path d="M15 4a11 11 0 1 1-8.6 4.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M6.5 2.5v6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg><span>15</span>
  </button>;
  const tempo = <button className="listening-tempo" aria-label="Playback speed" aria-haspopup="menu" aria-expanded={menu === 'speed'} onClick={() => setMenu(menu === 'speed' ? null : 'speed')}>{p.rate.toFixed(1)}×</button>;
  return <section className="listening-page" data-state={state} data-immersive={immersive}>
    {immersive ? <><div className="listening-top-progress"><span style={{ width: `${p.progress}%` }} /></div><div className="listening-immersive-meta">{author} · {Math.max(1, Math.ceil((p.duration - p.currentTime) / safeRate / 60))} min left</div></> : <>
      <header className="listening-top">{signedIn ? <button className="listening-icon" aria-label="Open library" onClick={onLibrary}><Book size={18} /></button> : <span className="listening-wordmark">Kinetic Reader</span>}<div className="listening-top-actions">
        <button className={signedIn ? 'listening-account listening-desktop-only' : 'listening-sign-in listening-desktop-only'} aria-label={signedIn ? 'Account' : 'Sign in'} onClick={onAuth}>
          {signedIn ? avatarUrl ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" /> : accountName ? accountName.charAt(0).toUpperCase() : <UserRound size={16} /> : 'Sign in'}
        </button>
        <button className="listening-icon" aria-label="More options" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}><Ellipsis size={20} /></button></div></header>
      {toast && <div className="listening-toast" role="status"><Check size={16} /><span>{toast}</span></div>}
      <div className="listening-title" data-cover={!!article.image && !finding && !extractFailed}>
        <div><div className="listening-meta"><strong>{author}</strong>{!finding && !extractFailed && <><span>·</span><span>AI narration</span>{durationLabel && <><span>·</span><span data-partial={partial}>{durationLabel}</span></>}</>}</div>
          {finding ? <div className="listening-skeleton" aria-label="Loading article title"><span /><span /></div> : extractFailed ? <p className="listening-raw-url">{source}</p> : <h1>{article.title}</h1>}
          {source && <a className="listening-source" href={source} target="_blank" rel="noopener noreferrer">{finding || extractFailed ? 'Open the original' : 'Read the original'}<ArrowUpRight size={11} /></a>}
        </div>
        {article.image && !finding && !extractFailed && <img className="listening-cover" src={article.image} alt="" onError={e => { e.currentTarget.style.display = 'none'; }} />}
      </div>
    </>}
    <main className="listening-stage" data-full={fullText}>
      {needsReview ? <div><h2>Check the captured article</h2><p>{notice || 'This may be a partial article.'}</p><div className="listening-review-text">{article.content}</div></div> : cancelled ? <div role="status">Preparation cancelled. Your saved text and completed audio are kept.</div> : finding ? <div className="listening-finding" role="status"><p>Getting the article ready…</p><span>You can leave this page. Your request is saved.</span></div> : extractFailed ? <div className="listening-extract-error" role="alert"><h2>We couldn’t read this article.</h2><p>{notice || 'The page may be unavailable, or require a login. Your request is saved in your library.'}</p></div> : <KineticDisplay words={p.words} articleText={article.content} currentWordIndex={p.currentWordIndex} currentTime={p.currentTime}
        isPending={p.currentTime === 0 || unavailable} onTogglePlay={toggle} onSelectWord={(index, startPlayback) => { if (fullText || window.matchMedia('(min-width: 640px)').matches) onWord(index, startPlayback); else toggle(); }} viewMode={fullText ? 'full' : 'kinetic'} theme={theme} />}
    </main>
    {immersive ? <div className="listening-ghost"><div>{playButton(true)}{tempo}</div>{hint && <span>Tap anywhere to pause</span>}</div> : <footer className="listening-bottom">
      {(needsReview || cancelled || extractFailed) ? <div className="listening-form">
        {canManage && <>{needsReview ? <button className="listening-primary" onClick={onApprove}>Use this text</button> : <button className="listening-primary" onClick={onRetry}>Try again</button>}
        {(needsReview || extractFailed) && <button onClick={() => setReplacing(!replacing)}>Paste text instead</button>}
        {replacing && <><textarea aria-label="Replacement article text" rows={6} value={replacement} onChange={e => setReplacement(e.target.value)} /><button disabled={!replacement.trim()} onClick={() => { onReplace?.(replacement); setReplacing(false); }}>Create audio from this text</button></>}</>}
        {source && <a className="listening-secondary-button" href={source} target="_blank" rel="noopener noreferrer">Open the original <ArrowUpRight size={14} /></a>}<button className="listening-primary" onClick={onCreate}>Try another link</button></div> : <>
        {(state === 'preparing' || loadingSaved || partial || audioFailed || notice) && <div className="listening-status" role={audioFailed ? 'alert' : 'status'} data-error={audioFailed}>
          {audioFailed ? <>We couldn’t finish the audio.<small>The text is still here to read.</small></> : loadingSaved ? 'Loading saved audio…' : state === 'preparing' ? <>Preparing your audio. You can come back to this link anytime.<button onClick={onShare}>Copy link</button></> : partial ? 'Start listening. The rest is still being prepared.' : notice}
        </div>}
        <div className="listening-scrubber" data-unknown={finding || audioFailed}>
          <span>{finding || audioFailed ? '–:––' : time(p.currentTime / safeRate)}</span>
          <div className="listening-seek" role="slider" aria-label="Audio position" tabIndex={unavailable ? -1 : 0} aria-disabled={unavailable} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.progress)} aria-valuetext={`${time(p.currentTime / safeRate)} elapsed`}
            onPointerDown={e => { if (!unavailable) { e.currentTarget.setPointerCapture?.(e.pointerId); seek(e.clientX, e.currentTarget); } }}
            onPointerMove={e => { if (!unavailable && e.buttons === 1) seek(e.clientX, e.currentTarget); }}
            onKeyDown={e => { if (unavailable) return; if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); if (e.key === 'Home' || e.key === 'End') onSeek(e.key === 'Home' ? 0 : 100); else skip(e.key === 'ArrowLeft' ? -15 : 15); } }}>
            <div className="listening-seek-track" data-partial={partial}>{partial && <span className="listening-ready" style={{ width: `${Math.min(100, p.bufferedSeconds / Math.max(1, p.duration) * 100)}%` }} />}<span className="listening-played" style={{ width: `${unavailable ? 0 : p.progress}%` }} />{!unavailable && <i style={{ left: `${p.progress}%` }} />}</div>
          </div>
          <span data-estimated={estimated}>{finding || audioFailed ? '–:––' : estimated ? `~${time(duration)}` : `−${time(Math.max(0, duration - p.currentTime / safeRate))}`}</span>
        </div>
        <div className="listening-transport">{finding || state === 'preparing' || loadingSaved ? <div className="listening-spinner" aria-label={loadingSaved ? 'Loading saved audio' : 'Preparing audio'}><LoadingRing /></div> : <>{skipButton(-1)}{playButton()}{skipButton(1)}</>}</div>
        {audioFailed && canManage && <button className="listening-primary" onClick={onRetry}>Try again</button>}
        <div className="listening-actions" data-disabled={finding}>{tempo}<button disabled={finding} onClick={() => { if (unavailable || fullText) { setFullText(!fullText); setFollow(false); } else { setFollow(true); if (!p.isPlaying) onPlay(); } }}><Text size={14} />{fullText ? 'Back to listening' : unavailable ? 'Read the text' : 'Follow along'}</button><button data-saved={saved} onClick={onSave}><Bookmark size={14} fill={saved ? 'currentColor' : 'none'} />{saved ? 'Saved' : 'Save'}</button><button onClick={onShare}><Share size={14} />Share</button><span className="listening-keyboard-hint listening-desktop-only"><kbd>Space</kbd>{p.isPlaying ? 'pause' : 'play'}</span></div>
        {canManage && (finding || state === 'preparing' || partial) && <button className="listening-dismiss" onClick={onCancel}>Cancel preparation</button>}
        {state !== 'preparing' && !partial && !audioFailed && <button className="listening-invitation" onClick={onCreate}>Turn your next article into audio <span>→</span></button>}
      </>}
    </footer>}
    {menu && <><button className="listening-menu-backdrop" aria-label="Close menu" onClick={() => setMenu(null)} /><div className="listening-menu" data-speed={menu === 'speed'} role="menu" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(null); } }}>
      {menu === 'speed' ? speeds.map(speed => <button role="menuitemradio" aria-checked={speed === p.rate} key={speed} onClick={() => { onSpeed(speed); setMenu(null); }}>{speed.toFixed(1)}×</button>) : <>
        <button role="menuitem" onClick={() => { onShare(); setMenu(null); }}>Share</button>{source && <a role="menuitem" href={source} target="_blank" rel="noopener noreferrer">Open original</a>}
        <button role="menuitem" onClick={() => { setFullText(!fullText); setFollow(false); setMenu(null); }}>{fullText ? 'Back to listening' : 'Read the text'}</button><button role="menuitem" onClick={() => setMenu('speed')}>Speed</button><button role="menuitem" onClick={() => { onLibrary(); setMenu(null); }}>Your library</button><button role="menuitem" onClick={() => { onAuth(); setMenu(null); }}>{signedIn ? 'Account' : 'Sign in'}</button>
      </>}
    </div></>}
  </section>;
}
