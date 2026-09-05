import { afterEach, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ListeningPage, type ListeningPageProps } from './ListeningPage';
import { CreateListening, SaveListeningSheet, ShareListeningSheet } from './ListeningSheets';
import { listeningCallbackURL, readListeningValue, writeListeningValue } from '../../utils/listeningSession';

afterEach(() => { cleanup(); localStorage.clear(); });
const article = { title: 'A good article worth listening to', author: 'A writer', content: 'Deep reading is a cadence the brain learns.', sourceUrl: 'https://example.com/article' };
function props(overrides: Partial<ListeningPageProps> = {}): ListeningPageProps {
  return { article, playback: { words: [], currentWordIndex: 0, currentTime: 0, duration: 840, isPlaying: false, rate: 1, progress: 0, bufferedSeconds: 0 }, prepState: 'complete', signedIn: false, saved: false,
    onPlay() {}, onSeek() {}, onSpeed() {}, onWord() {}, onSave() {}, onShare() {}, onCreate() {}, onLibrary() {}, onAuth() {}, onRetry() {}, ...overrides };
}
test('a partial recording is playable and never presented as complete', () => {
  let plays = 0;
  const view = render(<ListeningPage {...props({ prepState: 'partial', playback: { ...props().playback, bufferedSeconds: 180 }, onPlay: () => plays++ })} />);
  expect(view.getByText('3:00 ready')).toBeTruthy();
  expect(view.getByText('Start listening. The rest is still being prepared.')).toBeTruthy();
  fireEvent.click(view.getByRole('button', { name: /^Play$/ }));
  expect(plays).toBe(1);
  expect(view.queryByText('14 min')).toBeNull();
});
test('preparation retains the title and provides reading and sharing without playback', () => {
  const view = render(<ListeningPage {...props({ prepState: 'preparing' })} />);
  expect(view.getByRole('heading', { name: article.title })).toBeTruthy();
  expect(view.getByRole('button', { name: 'Read the text' })).toBeTruthy();
  expect(view.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  expect(view.queryByRole('button', { name: /^Play$/ })).toBeNull();
});
test('a completed recording waiting for bytes is described as saved audio without creation controls', () => {
  const view = render(<ListeningPage {...props({ prepState: 'loadingSaved', canManage: true })} />);
  expect(view.getByText('Loading saved audio…')).toBeTruthy();
  expect(view.getByLabelText('Loading saved audio')).toBeTruthy();
  expect(view.queryByText('Preparing your audio. You can come back to this link anytime.')).toBeNull();
  expect(view.queryByRole('button', { name: 'Cancel preparation' })).toBeNull();
});
test('extraction failure preserves the original link and offers another article', () => {
  let creates = 0;
  const view = render(<ListeningPage {...props({ prepState: 'extractFailed', onCreate: () => creates++ })} />);
  expect(view.getByRole('heading', { name: 'We couldn’t read this article.' })).toBeTruthy();
  expect(view.getAllByRole('link').every(link => link.getAttribute('href') === article.sourceUrl)).toBe(true);
  fireEvent.click(view.getByRole('button', { name: 'Try another link' })); expect(creates).toBe(1);
});
test('create rejects non-web links and submits a valid source', () => {
  let created = '';
  const view = render(<CreateListening isPlaying remainingSeconds={600} onBack={() => {}} onCreate={input => { created = input.sourceUrl || ''; }} />);
  const input = view.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
  fireEvent.submit(view.container.querySelector('form')!); expect(created).toBe('');
  fireEvent.change(input, { target: { value: article.sourceUrl } });
  fireEvent.submit(view.container.querySelector('form')!);
  expect(created).toBe(article.sourceUrl);
});
test('save sends the current callback and can be dismissed without touching playback', async () => {
  let callback = '', closed = 0;
  const view = render(<SaveListeningSheet currentTime={222} callbackURL={() => 'https://app.kinreader.com/?read=example&t=222'} onClose={() => closed++}
    sendMagicLink={async input => { callback = input.callbackURL; return {}; }} />);
  fireEvent.change(view.getByLabelText('Email address'), { target: { value: 'reader@example.com' } });
  fireEvent.submit(view.container.querySelector('form')!);
  await waitFor(() => expect(view.getByRole('heading', { name: 'Check your inbox' })).toBeTruthy());
  expect(callback).toContain('t=222');
  fireEvent.click(view.getByRole('button', { name: 'Not now, keep listening' })); expect(closed).toBe(1);
});
test('sharing waits for persistence and reports failure without pretending to copy', async () => {
  const view = render(<ShareListeningSheet article={article} duration={840} visibility="private" canManage onClose={() => {}}
    onApply={async () => { throw new Error('Sharing could not be saved'); }} />);
  fireEvent.click(view.getByRole('radio', { name: /Anyone with the link/ }));
  fireEvent.click(view.getByRole('button', { name: 'Copy link' }));
  await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Sharing could not be saved'));
  expect(view.queryByText('Link copied')).toBeNull();
});
test('callback preserves recording and position, keeping the owner capability out of the query', () => {
  window.location.href = 'https://app.kinreader.com/';
  writeListeningValue('owner_test', 'secret'.repeat(6));
  const callback = new URL(listeningCallbackURL({ ...article, recordingId: 'test' }, 222, 70));
  expect(callback.searchParams.get('read')).toBe('p_test');
  expect(callback.searchParams.get('t')).toBe('222');
  expect(callback.search).not.toContain('secret');
  expect(callback.hash).toContain('claim=');
  expect(readListeningValue<{ wordIndex: number }>('pendingSave', { wordIndex: 0 }).wordIndex).toBe(70);
});
