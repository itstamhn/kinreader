import type { WordTiming } from '../types';
import { articleContentDigest } from './articleCacheKey';

const MAX_CONVEX_WORDS = 8192;
const MAX_EXACT_TRACK_BYTES = 25 * 1024 * 1024;

export type ExactTrackCacheEntry = {
  audioUrl: string;
  words: WordTiming[];
  duration: number;
  timingsSource: 'soniox';
};

export type PersistExactTrackInput = {
  url: string;
  title?: string;
  author?: string;
  text: string;
  voice: string;
  blob: Blob;
  duration: number;
  words: WordTiming[];
};

type FinalizeTrackInput = Omit<PersistExactTrackInput, 'blob'> & {
  storageId: string;
  grant: string;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ExactTrackPersistenceDependencies = {
  requestUploadUrl(input: {
    cacheKey: string;
    contentDigest: string;
    voice: string;
  }): Promise<{
    uploadUrl: string;
    grant: string;
    expiresAt: number;
  }>;
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
  if (input.blob.size > MAX_EXACT_TRACK_BYTES) {
    throw new Error(`Exact track persistence supports at most ${MAX_EXACT_TRACK_BYTES} audio bytes`);
  }

  const contentDigest = await articleContentDigest(input.text);
  const { uploadUrl, grant } = await dependencies.requestUploadUrl({
    cacheKey: input.url,
    contentDigest,
    voice: input.voice,
  });
  const fetcher: Fetcher = dependencies.fetcher ?? fetch;
  const uploadResponse = await fetcher(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': `audio/mpeg; kinreader-grant=${grant}` },
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

  const result = await dependencies.finalizeTrack({
    url: input.url,
    ...(input.title ? { title: input.title } : {}),
    ...(input.author ? { author: input.author } : {}),
    text: input.text,
    voice: input.voice,
    storageId,
    grant,
    duration: input.duration,
    words: input.words,
  });
  if (
    result &&
    typeof result === 'object' &&
    (result as Record<string, unknown>).ok === false
  ) {
    const message = (result as Record<string, unknown>).error;
    throw new Error(typeof message === 'string' ? message : 'Exact track finalization failed');
  }
}
