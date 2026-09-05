import React from 'react';
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { ConvexReactClient } from 'convex/react';
import { getFunctionName } from 'convex/server';
import { App } from './App';
import { ConvexAppProvider } from './lib/convex';
import { SpeechEngine } from './utils/speechEngine';
import { writeListeningValue } from './utils/listeningSession';
const originals = { query: ConvexReactClient.prototype.query, mutation: ConvexReactClient.prototype.mutation, action: ConvexReactClient.prototype.action, loadAudioUrl: SpeechEngine.prototype.loadAudioUrl, fetch: global.fetch };
const ledger: string[] = [];
beforeEach(() => {
  localStorage.clear(); window.location.href = 'http://localhost/'; ledger.length = 0;
  ConvexReactClient.prototype.action = (async (name: any) => { ledger.push(`action:${getFunctionName(name)}`); throw new Error('No paid actions allowed'); }) as any;
  ConvexReactClient.prototype.mutation = (async (name: any) => { ledger.push(`mutation:${getFunctionName(name)}`); throw new Error('Unexpected mutation'); }) as any;
  ConvexReactClient.prototype.query = (async (name: any) => { ledger.push(`query:${getFunctionName(name)}`); return null; }) as any;
  global.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
});
afterEach(async () => {
  cleanup(); await new Promise(resolve => setTimeout(resolve, 80));
  ConvexReactClient.prototype.query = originals.query; ConvexReactClient.prototype.mutation = originals.mutation; ConvexReactClient.prototype.action = originals.action;
  SpeechEngine.prototype.loadAudioUrl = originals.loadAudioUrl; global.fetch = originals.fetch; localStorage.clear(); window.location.href = 'http://localhost/';
});
function createText(container: HTMLElement) {
  fireEvent.click(container.querySelector('button[title="Add Article or URL"]')!);
  fireEvent.click(Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Paste text')!);
  fireEvent.change(container.querySelector('textarea')!, { target: { value: 'A newly submitted article.' } });
  fireEvent.click(Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Create audio')!);
}
test('creation during playback keeps the selected track and offers an explicit Open action', async () => {
  let engine: SpeechEngine | undefined;
  SpeechEngine.prototype.loadAudioUrl = function (...args) { engine = this; return originals.loadAudioUrl.apply(this, args); };
  ConvexReactClient.prototype.mutation = (async (name: any) => { ledger.push(`mutation:${getFunctionName(name)}`); return 'background-created'; }) as any;
  const view = render(<ConvexAppProvider><App /></ConvexAppProvider>);
  await waitFor(() => expect(engine).toBeTruthy());
  act(() => { engine!.seekToWordIndex(6); engine!.isPlaying = true; engine!.setWordTimings(engine!.getSnapshot().words, engine!.getSnapshot().duration); });
  const before = engine!.getSnapshot();
  createText(view.container);
  await waitFor(() => expect(view.getByRole('button', { name: 'Open recording' })).toBeTruthy());
  expect(window.location.search).not.toContain('read=p_'); expect(view.container.textContent).toContain('DAN KOE');
  expect(engine!.getSnapshot().isPlaying).toBe(true); expect(engine!.getSnapshot().currentWordIndex).toBe(before.currentWordIndex); expect(engine!.getSnapshot().words).toBe(before.words);
  expect(ledger.filter(call => call.startsWith('mutation:'))).toEqual(['mutation:routers/listening:create']);
  expect(ledger.filter(call => call.startsWith('action:'))).toEqual([]);
});
test('navigation while submission is unacknowledged cannot be replaced by a late creation result', async () => {
  let acknowledge!: (id: string) => void;
  ConvexReactClient.prototype.mutation = (() => new Promise(resolve => { acknowledge = resolve; })) as any;
  const view = render(<ConvexAppProvider><App /></ConvexAppProvider>);
  createText(view.container);
  fireEvent.click(view.container.querySelector('button[title="Library & Queue"]')!);
  await act(async () => { acknowledge('late-recording'); });
  await waitFor(() => expect(view.getByRole('button', { name: 'Open recording' })).toBeTruthy());
  expect(window.location.search).not.toContain('read=p_'); expect(view.container.textContent).toContain('Queue');
});
function savedRecord(recordingId: string) {
  window.location.href = `http://localhost/?read=p_${recordingId}`;
  writeListeningValue(`owner_${recordingId}`, 'owner-'.repeat(6));
  ConvexReactClient.prototype.query = (async (name: any) => {
    const route = getFunctionName(name); ledger.push(`query:${route}`);
    if (route === 'routers/listening:get') return { recordingId, title: 'Saved article', content: 'Saved words.', narrationText: 'Saved words.', voice: 'Adrian', stage: 'complete', completed: 1, total: 1, openingReady: true, canManage: true, visibility: 'private', attempt: 1 };
    if (route === 'routers/narration:page') return { status: 'done', total: 1, completed: 1, error: null, sections: [{ index: 0, audioUrl: '/saved-section.mp3', duration: 2, words: [{ text: 'Saved', start: 0, end: 1 }, { text: 'words.', start: 1, end: 2 }] }] };
    return null;
  }) as any;
}
test('server ready status does not enable Play until saved bytes arrive', async () => {
  savedRecord('delayed-bytes'); let downloadStarted = false;
  global.fetch = (() => { downloadStarted = true; return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
  const view = render(<ConvexAppProvider><App /></ConvexAppProvider>);
  await waitFor(() => expect(downloadStarted).toBe(true));
  expect(view.getByLabelText('Loading saved audio')).toBeTruthy(); expect(view.queryByRole('button', { name: /^Play$/ })).toBeNull();
  expect(ledger.filter(call => call.startsWith('action:'))).toEqual([]);
});
test('failed saved-byte download retries retrieval without restarting paid generation', async () => {
  savedRecord('failed-bytes'); let downloads = 0;
  global.fetch = (async () => { downloads++; return new Response('', { status: 503 }); }) as unknown as typeof fetch;
  const view = render(<ConvexAppProvider><App /></ConvexAppProvider>);
  await waitFor(() => expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(downloads).toBeGreaterThanOrEqual(2));
  expect(ledger.filter(call => call.startsWith('action:') || call.startsWith('mutation:'))).toEqual([]);
});
test('pending recording reopens at the same ID after reload and progresses without new paid work', async () => {
  const recordingId = 'pending-reload';
  window.location.href = `http://localhost/?read=p_${recordingId}`;
  writeListeningValue(`owner_${recordingId}`, 'owner-'.repeat(6));
  let stage = 'finding';
  ConvexReactClient.prototype.query = (async (name: any) => {
    const route = getFunctionName(name); ledger.push(`query:${route}`);
    if (route === 'routers/listening:get') return { recordingId, title: stage === 'finding' ? 'example.com' : 'Captured after reload', content: stage === 'finding' ? '' : 'Saved words.', narrationText: stage === 'finding' ? undefined : 'Saved words.', voice: 'Adrian', stage, completed: stage === 'finding' ? 0 : 1, total: 2, openingReady: stage !== 'finding', canManage: true, visibility: 'private', attempt: 1 };
    if (route === 'routers/narration:page') return { status: 'running', total: 2, completed: 1, error: null, sections: [] };
    return null;
  }) as any;
  const first = render(<ConvexAppProvider><App /></ConvexAppProvider>);
  await waitFor(() => expect(first.container.textContent).toContain('Getting the article ready'));
  first.unmount(); stage = 'partial';
  const second = render(<ConvexAppProvider><App /></ConvexAppProvider>);
  await waitFor(() => expect(second.container.textContent).toContain('Captured after reload'), { timeout: 3500 });
  expect(window.location.search).toContain(`read=p_${recordingId}`);
  expect(ledger.filter(call => call.startsWith('mutation:') || call.startsWith('action:'))).toEqual([]);
  expect(JSON.parse(localStorage.getItem('kinetic_saved_articles_v2') || '[]').filter((item: any) => item.article.recordingId === recordingId)).toHaveLength(1);
});
