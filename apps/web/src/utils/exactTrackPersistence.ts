import type { WordTiming } from '../types';

const MAX_CONVEX_WORDS = 8192;

export type ExactTrackCacheEntry = {
  audioUrl: string;
  words: WordTiming[];
  duration: number;
  timingsSource: 'soniox';
};

export type PersistExactTrackInput = {
  clientId: string;
  url: string;
  title?: string;
  author?: string;
  text: string;
  voice: string;
  blob: Blob;
  duration: number;
  words: WordTiming[];
};

type FinalizeTrackInput = Omit<PersistExactTrackInput, 'clientId' | 'blob'> & {
  storageId: string;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ExactTrackPersistenceDependencies = {
  requestUploadUrl(clientId: string): Promise<{ uploadUrl: string }>;
  finalizeTrack(input: FinalizeTrackInput): Promise<unknown>;
  fetcher?: Fetcher;
};

function uploadedStorageId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const storageId = (value as Record<string, unknown>).storageId;
  return typeof storageId === 'string' && storageId.length > 0 ? storageId : null;
}

export async function uploadAndFinalizeExactTrack(
  input: PersistExactTrackInput,
  dependencies: ExactTrackPersistenceDependencies
): Promise<void> {
  if (input.words.length === 0 || input.words.length > MAX_CONVEX_WORDS) {
    throw new Error(`Exact track persistence supports at most ${MAX_CONVEX_WORDS} words`);
  }
  if (input.blob.size === 0) throw new Error('Cannot persist an empty audio track');

  const { uploadUrl } = await dependencies.requestUploadUrl(input.clientId);
  const fetcher: Fetcher = dependencies.fetcher ?? fetch;
  const uploadResponse = await fetcher(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/mpeg' },
    body: input.blob,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Exact track upload failed (status ${uploadResponse.status})`);
  }

  let uploadResult: unknown;
  try {
    uploadResult = await uploadResponse.json();
  } catch {
    throw new Error('Exact track upload returned an invalid response');
  }
  const storageId = uploadedStorageId(uploadResult);
  if (!storageId) throw new Error('Exact track upload returned no storageId');

  await dependencies.finalizeTrack({
    url: input.url,
    ...(input.title ? { title: input.title } : {}),
    ...(input.author ? { author: input.author } : {}),
    text: input.text,
    voice: input.voice,
    storageId,
    duration: input.duration,
    words: input.words,
  });
}
