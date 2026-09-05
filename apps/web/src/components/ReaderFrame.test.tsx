import { afterEach, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReaderFrame } from './ReaderFrame';
import { Controls } from './Controls';

afterEach(() => { cleanup(); localStorage.clear(); });

test('idle playback fades controls, a ghost pause works, and activity restores controls', async () => {
  let toggles = 0;
  const children = <Controls isPlaying onTogglePlay={() => toggles++} speed={1.5} onSpeedChange={() => {}}
    progress={10} onSeekProgress={() => {}} currentTime={10} duration={100} remainingSeconds={60} />;
  const { container, rerender } = render(<ReaderFrame isPlaying theme="dark">{children}</ReaderFrame>);
  const frame = container.querySelector('.reader-frame')!;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1550)); });
  expect(frame.getAttribute('data-chrome-visible')).toBe('false');
  expect(container.querySelector('.reader-bottom')?.hasAttribute('inert')).toBe(true);
  fireEvent.click(container.querySelector('.reader-ghost-pause')!);
  expect(toggles).toBe(1);
  expect(frame.getAttribute('data-chrome-visible')).toBe('true');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); });
  expect(frame.getAttribute('data-chrome-visible')).toBe('true');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1450)); });
  expect(frame.getAttribute('data-chrome-visible')).toBe('false');
  fireEvent.pointerMove(frame, { pointerType: 'mouse', buttons: 0 });
  expect(frame.getAttribute('data-chrome-visible')).toBe('true');
  rerender(<ReaderFrame isPlaying={false} theme="dark">{children}</ReaderFrame>);
  expect(frame.getAttribute('data-chrome-visible')).toBe('true');
}, 10000);

test('the reading hint stays dismissed after remount', () => {
  const first = render(<ReaderFrame isPlaying={false} theme="light">text</ReaderFrame>);
  fireEvent.click(first.getByRole('button', { name: 'Dismiss reading hint' }));
  first.unmount();
  const second = render(<ReaderFrame isPlaying={false} theme="light">text</ReaderFrame>);
  expect(second.queryByRole('button', { name: 'Dismiss reading hint' })).toBeNull();
});

test('first playback dismisses the hint permanently', () => {
  const ui = render(<ReaderFrame isPlaying={false} theme="dark">text</ReaderFrame>);
  expect(ui.getByRole('button', { name: 'Dismiss reading hint' })).toBeTruthy();
  ui.rerender(<ReaderFrame isPlaying theme="dark">text</ReaderFrame>);
  ui.rerender(<ReaderFrame isPlaying={false} theme="dark">text</ReaderFrame>);
  expect(ui.queryByRole('button', { name: 'Dismiss reading hint' })).toBeNull();
  expect(localStorage.getItem('kinreader_hint_seen')).toBe('1');
});
