import { afterEach, expect, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ArticleCreationForm } from './ArticleCreationForm';
import { ListeningPage, type ListeningPageProps } from './ListeningPage';

afterEach(cleanup);

function desktop() {
  const original = window.matchMedia.bind(window);
  return spyOn(window, 'matchMedia').mockImplementation(query => {
    const result = original(query);
    Object.defineProperty(result, 'matches', { value: query.includes('min-width: 640px') });
    return result;
  });
}

test('desktop paste fills the creation field without starting a second global flow', () => {
  const media = desktop();
  try {
    const view = render(<ArticleCreationForm layout="page" onCreate={() => {}} />);
    const input = view.getByRole('textbox', { name: 'Article link' }) as HTMLInputElement;
    let bubbled = 0;
    const globalPaste = () => { bubbled++; };
    window.addEventListener('paste', globalPaste);
    try {
      fireEvent.paste(document.body, { clipboardData: { getData: () => 'https://example.com/essay' } });
      expect(input.value).toBe('https://example.com/essay');
      expect(bubbled).toBe(0);
      expect((view.getByRole('button', { name: 'Create audio' }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.paste(input, { clipboardData: { getData: () => 'https://example.com/another' } });
      expect(input.value).toBe('https://example.com/essay');
      expect(bubbled).toBe(1);
    } finally { window.removeEventListener('paste', globalPaste); }
  } finally { media.mockRestore(); }
});

test('desktop word clicks seek and play keeps the controls until Follow along is chosen', () => {
  const media = desktop();
  try {
    let selected = -1, plays = 0;
    const props: ListeningPageProps = {
      article: { title: 'Reading', content: 'Read this sentence.' },
      playback: { words: [{ text: 'Read', start: 0, end: 1 }, { text: 'this', start: 1, end: 2 }, { text: 'sentence.', start: 2, end: 3 }], currentWordIndex: 0, currentTime: 0, duration: 3, isPlaying: false, rate: 1, progress: 0, bufferedSeconds: 3 },
      prepState: 'complete', saved: false, signedIn: false,
      onPlay: () => { plays++; }, onWord: index => { selected = index; }, onSeek() {}, onSpeed() {}, onSave() {}, onShare() {}, onCreate() {}, onLibrary() {}, onAuth() {}, onRetry() {},
    };
    const view = render(<ListeningPage {...props} />);
    fireEvent.click(view.getByRole('button', { name: /^this$/ }));
    expect(selected).toBe(1);
    expect(plays).toBe(0);
    fireEvent.click(view.getByRole('button', { name: /^Play$/ }));
    view.rerender(<ListeningPage {...props} playback={{ ...props.playback, isPlaying: true }} />);
    expect(view.getByRole('button', { name: /^Save$/ })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Follow along' }));
    expect(view.queryByRole('button', { name: /^Save$/ })).toBeNull();
    expect(view.getByRole('button', { name: /^Pause$/ })).toBeTruthy();
  } finally { media.mockRestore(); }
});
