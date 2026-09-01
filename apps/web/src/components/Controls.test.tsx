import { afterEach, expect, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Controls } from './Controls';

afterEach(cleanup);

const baseProps = {
  isPlaying: false,
  onTogglePlay: () => {},
  speed: 1,
  onSpeedChange: () => {},
  progress: 0,
  onSeekProgress: () => {},
  currentTime: 0,
  duration: 1,
  remainingSeconds: 1,
};

test('normal Blob-only buffering disables play without reporting degraded quality', () => {
  let playCalls = 0;
  const rendered = render(
    <Controls
      {...baseProps}
      onTogglePlay={() => {
        playCalls += 1;
      }}
      isPlayable={false}
      isBuffering={true}
      isDegraded={false}
    />
  );

  const playButton = rendered.getByRole('button', { name: /play/i }) as HTMLButtonElement;
  expect(playButton.disabled).toBe(true);
  expect(rendered.container.textContent).not.toContain('Neural voice unavailable');
  fireEvent.click(playButton);
  expect(playCalls).toBe(0);

  rendered.rerender(
    <Controls
      {...baseProps}
      onTogglePlay={() => {
        playCalls += 1;
      }}
      isPlayable={true}
      isBuffering={false}
      isDegraded={false}
    />
  );

  expect((rendered.getByRole('button', { name: /play/i }) as HTMLButtonElement).disabled).toBe(false);
});

test('degraded notice is reserved for REST or browser fallback', () => {
  const rendered = render(
    <Controls {...baseProps} isPlayable={true} isBuffering={false} isDegraded={true} />
  );

  expect(rendered.container.textContent).toContain('Neural voice unavailable');
});

test('a load notice is shown without disabling playback and can be dismissed', () => {
  let dismissed = 0;
  const rendered = render(
    <Controls
      {...baseProps}
      isPlayable={true}
      noticeMessage="Could not load example.com: timed out"
      onDismissNotice={() => {
        dismissed += 1;
      }}
    />
  );
  expect(rendered.container.textContent).toContain('Could not load example.com');
  expect((rendered.getByRole('button', { name: /play/i }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(rendered.getByRole('button', { name: /dismiss/i }));
  expect(dismissed).toBe(1);
});

test('the degraded copy can describe REST audio with estimated timing', () => {
  const rendered = render(
    <Controls
      {...baseProps}
      isPlayable={true}
      isDegraded={true}
      degradedMessage="Exact word sync unavailable — using estimated timing for this article."
    />
  );
  expect(rendered.container.textContent).toContain('Exact word sync unavailable');
  expect(rendered.container.textContent).not.toContain('Neural voice unavailable');
});
