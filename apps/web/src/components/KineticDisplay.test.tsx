import { afterEach, expect, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { KineticDisplay } from './KineticDisplay';

afterEach(cleanup);

const words = Array.from({ length: 40 }, (_, index) => ({
  text: 'word', start: index, end: index + 0.6,
}));

test('arrows navigate from the displayed page during a pause', () => {
  const selected: number[] = [];
  // Page two appears at 17.8, before its first word is spoken at 18.
  let pageNumber = 0;
  render(
    <KineticDisplay words={words} currentWordIndex={17} currentTime={17.9}
      onSelectWord={index => selected.push(index)} onPageChange={page => { pageNumber = page.number; }} viewMode="kinetic" />
  );
  expect(pageNumber).toBe(2);
  fireEvent.keyDown(window, { code: 'ArrowLeft' });
  fireEvent.keyDown(window, { code: 'ArrowRight' });
  expect(selected).toEqual([0, 36]);
});

test('timing corrections preserve the existing page and word elements', () => {
  const props = { currentWordIndex: 0, currentTime: 0, onSelectWord: () => {}, viewMode: 'kinetic' as const };
  const { container, rerender } = render(<KineticDisplay {...props} words={words} />);
  const page = container.querySelector('.editorial-page');
  const buttons = [...container.querySelectorAll('.editorial-word')];
  rerender(<KineticDisplay {...props} words={words.map(word => ({ ...word, end: word.end + 0.1 }))} />);
  expect(container.querySelector('.editorial-page')).toBe(page);
  expect(container.querySelectorAll('.editorial-word')).toHaveLength(buttons.length);
  container.querySelectorAll('.editorial-word').forEach((button, index) => expect(button).toBe(buttons[index]!));
});

test('page arrows respect article boundaries and text input', () => {
  const selected: number[] = [];
  const { getByRole, unmount } = render(<>
    <input aria-label="Article URL" />
    <KineticDisplay words={words} currentWordIndex={0} currentTime={0}
      onSelectWord={index => selected.push(index)} viewMode="kinetic" />
  </>);
  fireEvent.keyDown(window, { code: 'ArrowLeft' });
  fireEvent.keyDown(getByRole('textbox'), { code: 'ArrowRight' });
  expect(selected).toEqual([]);
  unmount();
  fireEvent.keyDown(window, { code: 'ArrowRight' });
  expect(selected).toEqual([]);
});

test('swipes turn pages without also seeking a word or toggling playback', () => {
  const selected: number[] = [];
  let plays = 0;
  const { container, getByRole } = render(<KineticDisplay words={words} currentWordIndex={0} currentTime={0}
    viewMode="kinetic" onSelectWord={index => selected.push(index)} onTogglePlay={() => plays++} />);
  const stage = getByRole('region');
  const word = container.querySelector('.editorial-word')!;
  fireEvent.pointerDown(word, { clientX: 250, clientY: 300 });
  fireEvent.pointerUp(word, { clientX: 100, clientY: 305 });
  fireEvent.click(word);
  expect(selected).toEqual([18]);
  expect(plays).toBe(0);
  fireEvent.pointerDown(stage, { clientX: 100, clientY: 300 });
  fireEvent.pointerUp(stage, { clientX: 100, clientY: 300 });
  fireEvent.click(stage);
  expect(plays).toBe(1);
  fireEvent.click(word);
  expect(selected).toEqual([18, 0]);
});
