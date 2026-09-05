// Local visual fixtures. This entry is not included in the production build.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReaderFrame } from '../src/components/ReaderFrame';
import { Header } from '../src/components/Header';
import { KineticDisplay } from '../src/components/KineticDisplay';
import { Controls } from '../src/components/Controls';
import '../src/index.css';

const requestedState = new URLSearchParams(location.search).get('state') || 'preparing';
if (requestedState === 'hint') localStorage.removeItem('kinreader_hint_seen');
const paragraph = 'Deep reading is not a talent. It is a cadence the brain learns, and cadence can be engineered.';
const longText = `${paragraph}\n\nWhen words arrive in clauses, pacing matches comprehension.\n\n${Array.from({ length: 10 }, () => paragraph).join('\n\n')}`;
const words = longText.split(/\s+/).map((text, index) => ({ text, start: index, end: index + .8 }));

function Preview() {
  const [phase, setPhase] = useState(requestedState);
  const [playing, setPlaying] = useState(phase === 'degraded');
  const [viewMode, setViewMode] = useState<'kinetic' | 'full'>(phase === 'full' ? 'full' : 'kinetic');
  const [index, setIndex] = useState(phase === 'full' ? 25 : 4);
  const [speed, setSpeed] = useState(1.5);
  const [page, setPage] = useState({ number: 1, count: 41 });
  const fetching = phase === 'fetching';
  const preparing = phase === 'preparing' || phase === 'saved';
  const article = { title: 'The cadence of reading', author: 'The Atlantic', content: longText, sourceUrl: 'https://theatlantic.com' };
  const toggleView = () => setViewMode(viewMode === 'kinetic' ? 'full' : 'kinetic');
  const noop = () => {};
  return <ReaderFrame isPlaying={playing} theme="dark" hintAvailable={phase === 'hint'}>
    <Header article={article} pendingUrl={fetching ? 'https://theatlantic.com/article' : undefined}
      remainingSeconds={840} onOpenSettings={noop} onOpenInput={noop} onOpenLibrary={noop} onToggleViewMode={toggleView} viewMode={viewMode} />
    <KineticDisplay words={fetching ? [] : words} isFetching={fetching} isPending={preparing || phase === 'hint'}
      currentTime={index} currentWordIndex={index} onSelectWord={setIndex} onTogglePlay={() => setPlaying(!playing)}
      onPageChange={setPage} viewMode={viewMode} articleText={longText} />
    <Controls isPlaying={playing} isFetching={fetching} awaitingSavedRecording={phase === 'saved'}
      onTogglePlay={() => setPlaying(!playing)} speed={speed} onSpeedChange={setSpeed} progress={22}
      onSeekProgress={value => setIndex(Math.floor(value / 100 * words.length))} currentTime={index} duration={words.length} remainingSeconds={840}
      isPlayable={!preparing && !fetching} isBuffering={preparing} isError={phase === 'error'}
      loadingProgress={phase === 'preparing' ? { readySeconds: 4, targetSeconds: 12, waiting: true } : undefined}
      bufferedProgress={phase === 'preparing' ? 33 : undefined} isDegraded={phase === 'degraded'} degradedMessage="Saved audio has estimated word timings."
      infoMessage={phase === 'truncated' ? 'Narrating the first 4,000 of 6,212 words' : undefined}
      noticeMessage={phase === 'notice' ? 'Couldn’t read example.com: no article text found' : undefined}
      onDismissNotice={() => setPhase('ready')}
      infoAction={phase === 'error' ? { label: 'Retry audio', onClick: () => setPhase('preparing') } :
        phase === 'saved' ? { label: 'Play now', onClick: () => setPhase('preparing') } : undefined}
      viewMode={viewMode} onToggleViewMode={toggleView} sourceUrl={article.sourceUrl} pageNumber={page.number} pageCount={page.count} />
  </ReaderFrame>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
