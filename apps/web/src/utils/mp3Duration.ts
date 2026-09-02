// The streaming client lives in the shared backend package so the Convex
// pre-generation action can run the same code server-side; this module only
// keeps the reader's import paths stable.
export { concatBytes, mp3DurationSeconds } from '@kinreader/backend/tts/mp3Duration';
