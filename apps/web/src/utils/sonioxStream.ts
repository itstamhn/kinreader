// The streaming client lives in the shared backend package so the Convex
// pre-generation action can run the same code server-side; this module only
// keeps the reader's import paths stable.
export {
  openSonioxStream,
  SonioxProtocolError,
  SonioxTemporaryKeyExpiredError,
} from '@kinreader/backend/tts/sonioxStream';
export type {
  OpenSonioxStreamOptions,
  SonioxStreamHandlers,
  SonioxTimestamps,
} from '@kinreader/backend/tts/sonioxStream';
