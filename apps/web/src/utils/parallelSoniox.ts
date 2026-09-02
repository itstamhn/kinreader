// The streaming client lives in the shared backend package so the Convex
// pre-generation action can run the same code server-side; this module only
// keeps the reader's import paths stable.
export {
  chooseSegmentCount,
  MAX_PARALLEL_SEGMENTS,
  MAX_CHARS_PER_SEGMENT,
  MIN_CHARS_PER_SEGMENT,
  openParallelSonioxStream,
  splitIntoSegments,
} from '@kinreader/backend/tts/parallelSoniox';
export type { OpenParallelSonioxStreamOptions } from '@kinreader/backend/tts/parallelSoniox';
