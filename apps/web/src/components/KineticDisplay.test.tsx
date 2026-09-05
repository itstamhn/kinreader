import { afterEach, expect, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { KineticDisplay } from './KineticDisplay';

afterEach(cleanup);

const words = Array.from({ length: 40 }, (_, index) => ({
  text: 'word', start: index, end: index + 0.6,
}));

test('arrows and buttons navigate from the displayed page during a pause', () => {
  const selected: number[] = [];
  // Page two appears at 17.8, before its first word is spoken at 18.
  const { getByRole, getByText } = render(
    <KineticDisplay words={words} currentWordIndex={17} currentTime={17.9}
      onSelectWord={index => selected.push(index)} viewMode="kinetic" />
  );
  expect(getByText('2 / 3')).toBeTruthy();
  fireEvent.keyDown(window, { code: 'ArrowLeft' });
  fireEvent.click(getByRole('button', { name: 'Previous reading page' }));
  fireEvent.keyDown(window, { code: 'ArrowRight' });
  fireEvent.click(getByRole('button', { name: 'Next reading page' }));
  expect(selected).toEqual([0, 0, 36, 36]);
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
