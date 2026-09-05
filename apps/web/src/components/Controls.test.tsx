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
  expect(rendered.container.textContent).not.toContain('Word highlighting is estimated for this article');
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

test('degraded notice describes estimated highlighting without suggesting a device voice', () => {
  const rendered = render(
    <Controls {...baseProps} isPlayable={true} isBuffering={false} isDegraded={true} />
  );

  expect(rendered.container.textContent).toContain('Word highlighting is estimated for this article');
  expect(rendered.container.textContent).not.toContain('on-device');
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
  expect(rendered.getByTitle('Exact word sync unavailable — using estimated timing for this article.')).toBeTruthy();
  expect(rendered.container.textContent).not.toContain('Neural voice unavailable');
});

test('preparation shows listening time and keeps Full Text available', () => {
  let toggled = 0;
  const rendered = render(<Controls {...baseProps}
    isPlayable={false} isBuffering={true}
    loadingProgress={{ readySeconds: 20, targetSeconds: 60, waiting: true }}
    onToggleViewMode={() => { toggled += 1; }}
  />);
  expect(rendered.getByRole('status').textContent).toContain('00:20 of 01:00 ready');
  expect(rendered.getByRole('progressbar').getAttribute('value')).toBe('20');
  fireEvent.click(rendered.getByRole('button', { name: /full text/i }));
  expect(toggled).toBe(1);
});

test('buffering playback can be paused and promises automatic resume', () => {
  let paused = 0;
  const rendered = render(<Controls {...baseProps}
    isPlaying={true} isPlayable={true} isBuffering={true}
    onTogglePlay={() => { paused += 1; }}
    loadingProgress={{ readySeconds: 3, targetSeconds: 15, waiting: true }}
  />);
  fireEvent.click(rendered.getByRole('button', { name: /pause buffering/i }));
  expect(paused).toBe(1);
  expect(rendered.container.textContent).toContain('Playback will resume automatically.');
});

test('fetching has only a ring and does not seek or offer stale playback controls', () => {
  let seeks = 0;
  const ui = render(<Controls {...baseProps} isFetching onSeekProgress={() => seeks++} />);
  expect(ui.queryByRole('button', { name: /play/i })).toBeNull();
  expect(ui.container.querySelector('.reader-loading-ring')).toBeTruthy();
  fireEvent.pointerDown(ui.getByRole('slider'), { clientX: 20 });
  fireEvent.keyDown(ui.getByRole('slider'), { key: 'End' });
  expect(seeks).toBe(0);
});

test('checking saved audio offers Play now and becomes ordinary playback when ready', () => {
  let playNow = 0;
  const ui = render(<Controls {...baseProps} awaitingSavedRecording isPlayable={false}
    infoAction={{ label: 'Play now', onClick: () => playNow++ }} />);
  expect(ui.getByRole('status').textContent).toContain('Checking for a saved recording…');
  fireEvent.click(ui.getByRole('button', { name: 'Play now' }));
  expect(playNow).toBe(1);
  ui.rerender(<Controls {...baseProps} />);
  expect(ui.container.querySelector('.reader-loading-ring')).toBeNull();
  expect((ui.getByRole('button', { name: 'Play (Space)' }) as HTMLButtonElement).disabled).toBe(false);
});

test('failure stops the ring, preserves the reason, and keeps Retry available', () => {
  let retries = 0;
  const ui = render(<Controls {...baseProps} isError isBuffering isPlayable={false}
    infoMessage="Soniox is busy. Please retry." infoAction={{ label: 'Retry audio', onClick: () => retries++ }} />);
  expect(ui.container.querySelector('.reader-loading-ring')).toBeNull();
  expect(ui.getByRole('alert').textContent).toContain('Audio couldn’t be loaded');
  expect(ui.getByTitle('Soniox is busy. Please retry.')).toBeTruthy();
  fireEvent.click(ui.getByRole('button', { name: 'Retry' }));
  expect(retries).toBe(1);
});

test('notices take priority over preparation and full text hides the page count', () => {
  const ui = render(<Controls {...baseProps} viewMode="full" pageNumber={3} pageCount={12}
    noticeMessage="Couldn’t read example.com: no article found" onDismissNotice={() => {}}
    infoMessage="Narrating the first 100 of 200 words" />);
  expect(ui.queryByText('Narrating the first 100 of 200 words')).toBeNull();
  expect(ui.queryByText('3 / 12')).toBeNull();
  expect(ui.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
});
