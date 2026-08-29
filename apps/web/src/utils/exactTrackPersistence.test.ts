import { expect, test } from 'bun:test';
import { uploadAndFinalizeExactTrack } from './exactTrackPersistence';

const words = [
  { text: 'Exact', start: 0.1, end: 0.35 },
  { text: 'timing', start: 0.4, end: 0.7 },
];

test('uploads the completed MP3 Blob through the upload URL before finalizing its storageId', async () => {
  const blob = new Blob([new Uint8Array([4, 5, 6])], { type: 'audio/mpeg' });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const finalized: any[] = [];

  await uploadAndFinalizeExactTrack(
    {
      clientId: 'browser-client',
      url: 'https://example.com/exact',
      title: 'Exact Track',
      author: 'Author',
      text: 'Exact timing',
      voice: 'Adrian',
      blob,
      duration: 0.7,
      words,
    },
    {
      requestUploadUrl: async () => ({ uploadUrl: 'https://upload.example/track' }),
      fetcher: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ storageId: 'storage-id-from-upload' }), { status: 200 });
      },
      finalizeTrack: async (input) => {
        finalized.push(input);
      },
    }
  );

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: 'https://upload.example/track',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: blob,
    },
  });
  expect(finalized).toEqual([
    {
      url: 'https://example.com/exact',
      title: 'Exact Track',
      author: 'Author',
      text: 'Exact timing',
      voice: 'Adrian',
      storageId: 'storage-id-from-upload',
      duration: 0.7,
      words,
    },
  ]);
});

test('rejects oversized timing arrays before requesting an upload URL', async () => {
  let uploadUrlRequests = 0;
  await expect(
    uploadAndFinalizeExactTrack(
      {
        clientId: 'browser-client',
        url: 'https://example.com/too-many-words',
        text: 'word',
        voice: 'Adrian',
        blob: new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }),
        duration: 1,
        words: Array.from({ length: 8193 }, (_, index) => ({
          text: `w${index}`,
          start: index,
          end: index + 0.5,
        })),
      },
      {
        requestUploadUrl: async () => {
          uploadUrlRequests += 1;
          return { uploadUrl: 'https://upload.example/track' };
        },
        fetcher: async () => new Response(JSON.stringify({ storageId: 'unused' })),
        finalizeTrack: async () => {},
      }
    )
  ).rejects.toThrow('8192');
  expect(uploadUrlRequests).toBe(0);
});
