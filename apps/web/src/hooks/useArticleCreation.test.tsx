import { test, expect, afterEach } from 'bun:test';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useArticleCreation } from './useArticleCreation';
import { recordingOwnerToken } from '../utils/listeningSession';
afterEach(() => { cleanup(); localStorage.clear(); });
test('duplicate submissions join the same request and retain a capability before acknowledgement', async () => {
  let resolve!: (id: string) => void; let calls = 0; const saved: any[] = [];
  const { result } = renderHook(() => useArticleCreation(async () => { calls++; return new Promise<string>(done => { resolve = done; }); }, article => saved.push(article)));
  let first!: Promise<any>; let second!: Promise<any>;
  act(() => { first = result.current.submit({ sourceUrl: 'https://example.com/article' }); second = result.current.submit({ sourceUrl: 'https://example.com/article' }); });
  expect(first).toBe(second); expect(calls).toBe(1); expect(result.current.pending?.ownerToken.length).toBeGreaterThan(31);
  await act(async () => { resolve('record-one'); await first; });
  expect(saved).toHaveLength(1); expect(saved[0].stage).toBe('finding'); expect(recordingOwnerToken('record-one')).toBeTruthy();
});
test('uncertain response and reload reuse the original creation token', async () => {
  const tokens: string[] = [];
  const first = renderHook(() => useArticleCreation(async input => { tokens.push(input.ownerToken); throw new Error('Response lost'); }, () => {}));
  await act(async () => { await first.result.current.submit({ content: 'My article' }).catch(() => {}); });
  expect(first.result.current.error).toBe('Response lost'); first.unmount();
  const second = renderHook(() => useArticleCreation(async input => { tokens.push(input.ownerToken); return 'same-record'; }, () => {}));
  expect(second.result.current.pending?.input.content).toBe('My article');
  await act(async () => { await second.result.current.retry(); });
  expect(tokens).toHaveLength(2); expect(tokens[1]).toBe(tokens[0]); expect(second.result.current.pending).toBeNull();
});
test('a different input cannot silently join the request that is still being acknowledged', async () => {
  let resolve!: (id: string) => void; let calls = 0;
  const { result } = renderHook(() => useArticleCreation(() => { calls++; return new Promise<string>(done => { resolve = done; }); }, () => {}));
  let pending!: Promise<any>;
  act(() => { pending = result.current.submit({ content: 'First article' }); });
  await act(async () => { await expect(result.current.submit({ content: 'Different article' })).rejects.toThrow('Another article'); });
  expect(calls).toBe(1); expect(result.current.pending?.input.content).toBe('First article');
  await act(async () => { resolve('first-record'); await pending; });
});
test('a lost acknowledgement keeps the original token when a different article is attempted', async () => {
  const calls: Array<{ ownerToken: string; content?: string }> = [];
  const { result } = renderHook(() => useArticleCreation(async input => {
    calls.push(input);
    if (calls.length === 1) throw new Error('Acknowledgement lost');
    return 'original-record';
  }, () => {}));
  await act(async () => { await result.current.submit({ content: 'Article A' }).catch(() => {}); });
  const retained = localStorage.getItem('kinreader_listening_creation');
  await act(async () => { await expect(result.current.submit({ content: 'Article B' })).rejects.toThrow('Use Retry creation'); });
  expect(calls).toHaveLength(1);
  expect(localStorage.getItem('kinreader_listening_creation')).toBe(retained);
  expect(result.current.pending?.input.content).toBe('Article A');
  await act(async () => { await result.current.retry(); });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.ownerToken).toBe(calls[0]?.ownerToken);
  expect(calls[1]?.content).toBe('Article A');
  expect(recordingOwnerToken('original-record')).toBe(calls[0]?.ownerToken);
  expect(result.current.pending).toBeNull();
});
test('invalid and oversized input is rejected before retaining a retry token', async () => {
  let calls = 0;
  const { result } = renderHook(() => useArticleCreation(async () => { calls++; return 'record'; }, () => {}));
  for (const input of [
    { sourceUrl: 'not a URL' }, { sourceUrl: 'ftp://example.com/article' }, { sourceUrl: 'http://127.0.0.1/article' },
    { sourceUrl: `https://example.com/${'a'.repeat(2048)}` },
    { content: 'x'.repeat(150001) }, { content: 'Text', title: 'x'.repeat(501) }, { content: '   ' },
  ]) {
    await act(async () => { await expect(result.current.submit(input)).rejects.toThrow(); });
    expect(localStorage.getItem('kinreader_listening_creation')).toBeNull();
  }
  expect(calls).toBe(0); expect(result.current.pending).toBeNull();
});
