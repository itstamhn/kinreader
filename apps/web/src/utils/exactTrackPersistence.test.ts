import { expect, test } from 'bun:test';
import { uploadAndFinalizeExactTrack } from './exactTrackPersistence';

const words = [
  { text: 'Exact', start: 0.1, end: 0.35 },
  { text: 'timing', start: 0.4, end: 0.7 },
];

test('uploads the completed MP3 Blob through the upload URL before finalizing its storageId', async () => {
  const blob = new Blob([new Uint8Array([4, 5, 6])], { type: 'audio/mpeg' });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const uploadUrlRequests: unknown[] = [];
  const finalized: any[] = [];

  await uploadAndFinalizeExactTrack(
    {
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
      requestUploadUrl: async (input) => {
        uploadUrlRequests.push(input);
        return {
          uploadUrl: 'https://upload.example/track',
          grant: 'single-use-upload-grant',
          expiresAt: 123456,
        };
      },
      fetcher: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ storageId: 'storage-id-from-upload' }), { status: 200 });
      },
      finalizeTrack: async (input) => {
        finalized.push(input);
      },
    }
  );

  expect(uploadUrlRequests).toEqual([
    {
      cacheKey: 'https://example.com/exact',
      contentDigest: 'b2d0149d4df84e1408ed3208160aa121666399f06ebc62f7636aaeac1d329fb6',
      voice: 'Adrian',
    },
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: 'https://upload.example/track',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg; kinreader-grant=single-use-upload-grant' },
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
      grant: 'single-use-upload-grant',
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
          return {
            uploadUrl: 'https://upload.example/track',
            grant: 'unused-grant',
            expiresAt: 123456,
          };
        },
        fetcher: async () => new Response(JSON.stringify({ storageId: 'unused' })),
        finalizeTrack: async () => {},
      }
    )
  ).rejects.toThrow('8192');
  expect(uploadUrlRequests).toBe(0);
});

test('surfaces a server finalization rejection after the server safely cleans up the upload', async () => {
  await expect(
    uploadAndFinalizeExactTrack(
      {
        url: 'https://example.com/rejected',
        text: 'Exact timing',
        voice: 'Adrian',
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
        duration: 0.7,
        words,
      },
      {
        requestUploadUrl: async () => ({
          uploadUrl: 'https://upload.example/track',
          grant: 'single-use-upload-grant',
          expiresAt: 123456,
        }),
        fetcher: async () =>
          new Response(JSON.stringify({ storageId: 'rejected-storage-id' }), { status: 200 }),
        finalizeTrack: async () => ({
          ok: false,
          error: 'Exact track upload exceeds the byte limit',
        }),
      }
    )
  ).rejects.toThrow('exceeds the byte limit');
});
