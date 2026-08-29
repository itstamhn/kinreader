import { z } from 'zod';
import { action } from '../crpc';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';

// Ported from src/server.ts's `POST /api/tts` handler (plan 005's guards
// included). The route is removed from Spiceflow in the same change that
// lands this -- see plans/007-move-tts-to-convex-with-file-storage.md.
//
// Convex values are capped at 1MB, so unlike the old endpoint this never
// returns audio bytes inline: the MP3 goes through `ctx.storage` and only a
// signed URL comes back. `words` has its own 8192-entry array ceiling --
// capped below rather than letting the insert throw.
const MAX_TTS_CHARS = 50000;
const MAX_WORDS = 8192;

type WordTiming = { text: string; start: number; end: number };

// Explicit return type breaks a TS circularity: `internal`/`api` (from
// _generated/api) aggregate every router module including this one, so
// inferring `synthesize`'s type from its own body would require already
// knowing it.
type SynthesizeResult =
  | {
      audioUrl: string;
      words: WordTiming[];
      duration: number;
      provider: 'soniox';
      cached: boolean;
      articleId?: string;
      wordsTruncated?: boolean;
    }
  | {
      words: WordTiming[];
      duration: number;
      provider: 'browser';
      cached: boolean;
      articleId?: string;
      message?: string;
      warning?: string;
    };

function round(num: number, decimals = 3) {
  return Number(Math.round(Number(num + 'e' + decimals)) + 'e-' + decimals);
}

function linearWordTimings(text: string, speed = 1.0): { words: WordTiming[]; duration: number } {
  const rawWords = text.split(/\s+/).filter(Boolean);
  let curTime = 0;
  const words = rawWords.map((w) => {
    const start = curTime;
    // Kept in step with App.tsx's copy -- re-derived against the Adrian voice's
    // real pace (177 WPM measured; the old constants produced 265 WPM).
    let d = Math.max(0.21, Math.min(0.66, w.length * 0.063));
    if (/[,\;:]$/.test(w)) {
      d += 0.075;
    } else if (/[.!?]$/.test(w)) {
      d += 0.24;
    } else if (/[—–]$/.test(w)) {
      d += 0.15;
    }
    const duration = d / (speed > 0 ? speed : 1.0);
    const end = start + duration;
    curTime = end;
    return { text: w, start: round(start), end: round(end) };
  });
  return { words, duration: round(curTime) };
}

const MAX_SONIOX_CHUNK_CHARS = 450;
const MAX_SONIOX_SYNTH_CHARS = 900;

function splitTextIntoSonioxChunks(fullText: string, maxChunkSize = MAX_SONIOX_CHUNK_CHARS): string[] {
  let textToSynthesize = fullText.trim();
  if (textToSynthesize.length > MAX_SONIOX_SYNTH_CHARS) {
    const rawSlice = textToSynthesize.slice(0, MAX_SONIOX_SYNTH_CHARS);
    const lastBoundary = Math.max(
      rawSlice.lastIndexOf('. '),
      rawSlice.lastIndexOf('! '),
      rawSlice.lastIndexOf('? '),
      rawSlice.lastIndexOf('.\n'),
      rawSlice.lastIndexOf('\n')
    );
    textToSynthesize = lastBoundary > 300 ? rawSlice.slice(0, lastBoundary + 1).trim() : rawSlice.trim();
  }

  if (textToSynthesize.length <= maxChunkSize) {
    return [textToSynthesize];
  }

  const chunks: string[] = [];
  const sentences = textToSynthesize.match(/[^.!?\n]+[.!?\n]+(?:\s+|$)|[^.!?\n]+$/g) || [textToSynthesize];
  let curChunk = '';

  for (const rawSent of sentences) {
    const sent = rawSent.trim();
    if (!sent) continue;

    if ((curChunk + ' ' + sent).trim().length <= maxChunkSize) {
      curChunk = curChunk ? curChunk + ' ' + sent : sent;
    } else {
      if (curChunk) {
        chunks.push(curChunk.trim());
        curChunk = '';
      }
      if (sent.length <= maxChunkSize) {
        curChunk = sent;
      } else {
        const words = sent.split(/\s+/);
        for (const w of words) {
          if ((curChunk + ' ' + w).trim().length <= maxChunkSize) {
            curChunk = curChunk ? curChunk + ' ' + w : w;
          } else {
            if (curChunk) chunks.push(curChunk.trim());
            curChunk = w;
          }
        }
      }
    }
  }
  if (curChunk) chunks.push(curChunk.trim());
  return chunks.filter(Boolean);
}

type TemporaryKeyResult = { apiKey: string; expiresAt: string };

function isTemporaryKeyResponse(value: unknown): value is { api_key: string; expires_at: string } {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.api_key === 'string' &&
    response.api_key.length > 0 &&
    typeof response.expires_at === 'string' &&
    !Number.isNaN(Date.parse(response.expires_at))
  );
}

export const temporaryKey = action
  .input(z.object({ clientId: z.string().optional() }))
  .action(async ({ ctx, input }): Promise<TemporaryKeyResult> => {
    const sonioxApiKey = process.env.SONIOX_API_KEY;
    if (!sonioxApiKey) {
      throw new Error('SONIOX_API_KEY is not configured');
    }

    const identity = await ctx.auth?.getUserIdentity?.();
    // Authenticated identities are server-derived; a caller-provided clientId
    // remains only an anonymous attribution/fairness bucket. This preserves
    // anonymous narration as an explicit product ruling.
    const clientReferenceId = identity?.tokenIdentifier || input.clientId || 'anonymous';

    const rateLimit: { ok: boolean } = await ctx.runMutation(internal.routers.ttsInternal.consumeTtsRateLimit, {
      key: clientReferenceId,
      purpose: 'temporaryKey',
    });
    if (!rateLimit.ok) {
      throw new Error('Too many temporary key requests. Please try again in a minute.');
    }

    let response: Response;
    try {
      // Soniox's API reference index also names `/v1/create_temporary_api_key`,
      // but that endpoint 404s; use this Step 0-verified spelling instead.
      response = await fetch('https://api.soniox.com/v1/auth/temporary-api-key', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sonioxApiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          usage_type: 'tts_rt',
          expires_in_seconds: 300,
          max_session_duration_seconds: 900,
          single_use: true,
          client_reference_id: clientReferenceId,
        }),
      });
    } catch {
      throw new Error('Unable to reach Soniox while issuing a temporary key');
    }

    if (!response.ok) {
      throw new Error(`Soniox rejected temporary key issuance (status ${response.status})`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('Soniox returned an invalid temporary key response');
    }
    if (!isTemporaryKeyResponse(payload) || payload.api_key === sonioxApiKey) {
      throw new Error('Soniox returned an invalid temporary key response');
    }

    return { apiKey: payload.api_key, expiresAt: payload.expires_at };
  });

export const synthesize = action
  .input(
    z.object({
      // Identifies the article for caching purposes -- the same key
      // src/lib/storage.ts used for its (now-retired) sessionStorage cache.
      url: z.string().min(1),
      title: z.string().optional(),
      author: z.string().optional(),
      text: z.string().min(1),
      voice: z.string().optional(),
      speed: z.number().optional(),
      // Bring-your-own-key overrides (ReaderSettings) take priority over
      // the deployment's own SONIOX_API_KEY / GROQ_API_KEY env vars.
      sonioxApiKey: z.string().optional(),
      groqApiKey: z.string().optional(),
      // Stable per-browser id (src/lib/storage.ts's getOrCreateClientId) --
      // there is no per-user identity until plan 008, so this is the "stable
      // client identifier" the rate limiter keys on until then.
      clientId: z.string().optional(),
    })
  )
  .action(async ({ ctx, input }): Promise<SynthesizeResult> => {
    const text = input.text.trim();
    const voice = input.voice || 'Adrian';
    const speed = input.speed || 1.0;

    // `synthesize` is public and unauthenticated -- there is no
    // `ctx.auth` identity to gate on (no convex/auth.config.ts, no users
    // keyed by auth subject; that is plan 008's job). Until then, EVERY
    // gate below must run before the FIRST write (getOrCreateArticleStub,
    // step 4) or an attacker can grow the `articles` table for free by
    // looping with a fresh `url` per request, never reaching a provider
    // and never tripping a limiter because the write already happened.

    // 1. Size check: pure input validation, no I/O, no write, no limiter
    // spend. Same hard cap plan 005 put on the Worker route -- text over
    // this length is rejected outright (not truncated-and-sent), so it
    // never reaches Soniox, a limiter, or the article-stub write.
    if (text.length > MAX_TTS_CHARS) {
      const { words, duration } = linearWordTimings(text);
      return {
        words,
        duration,
        provider: 'browser' as const,
        cached: false,
        message: `Text exceeds the ${MAX_TTS_CHARS} character limit; using native speech engine.`,
      };
    }

    const rawWords = text.split(/\s+/).filter(Boolean);

    // 2. Cache lookup BY URL -- read-only, and deliberately does NOT
    // create the article row (see ttsInternal.ts's findCachedTrackByUrl).
    // A hit must short-circuit here, before either rate limiter runs and
    // before the write in step 4, or every cache hit would needlessly
    // spend a token / a write would happen before we even know one is
    // unnecessary.
    const cached: Doc<'audioTracks'> | null = await ctx.runQuery(
      internal.routers.ttsInternal.findCachedTrackByUrl,
      { url: input.url, voice, speed }
    );
    if (cached && cached.storageId) {
      // Invalidate old stale tracks that were artificially capped to ~650 chars (<= 120 words for long text)
      const isStaleTruncated = rawWords.length > 150 && cached.words.length < rawWords.length * 0.7;
      if (!isStaleTruncated) {
        const audioUrl: string | null = await ctx.storage.getUrl(cached.storageId);
        if (audioUrl) {
          return {
            audioUrl,
            words: cached.words,
            duration: cached.duration,
            provider: 'soniox' as const,
            cached: true,
            articleId: cached.articleId,
          };
        }
      }
      // The stored file is gone or truncated -- fall through and regenerate.
    }

    const sonioxApiKey = input.sonioxApiKey || process.env.SONIOX_API_KEY;
    const groqApiKey = input.groqApiKey || process.env.GROQ_API_KEY;

    // No key anywhere -- this can never call a paid provider, so (matching
    // the old `willCallPaidProvider` check) it is never rate limited, and
    // (matching every other non-write branch above) never writes.
    if (!sonioxApiKey) {
      const { words, duration } = linearWordTimings(text);
      return {
        words,
        duration,
        provider: 'browser' as const,
        cached: false,
        message: 'Using native speech engine.',
      };
    }

    // 3. About to call a paid provider -- consume the global limiter, then
    // the per-client one. Still before any write.
    const rateLimitKey = input.clientId || 'anonymous';
    const status: { ok: boolean } = await ctx.runMutation(internal.routers.ttsInternal.consumeTtsRateLimit, {
      key: rateLimitKey,
    });
    if (!status.ok) {
      const { words, duration } = linearWordTimings(text);
      return {
        words,
        duration,
        provider: 'browser' as const,
        cached: false,
        warning: 'Rate limit exceeded. Please try again in a minute.',
      };
    }

    // 4. First write, only now that every gate above has passed.
    const articleId: Id<'articles'> = await ctx.runMutation(
      internal.routers.ttsInternal.getOrCreateArticleStub,
      {
        url: input.url,
        title: input.title,
        author: input.author,
        content: text,
      }
    );

    try {
      // 5. Generate Soniox TTS v2 audio for the article.
      // Split text into natural chunks (~450 chars) and synthesize sequentially
      // to respect Soniox single-session concurrency limit, then concatenate into
      // a single continuous MP3 audio buffer.
      const textChunks = splitTextIntoSonioxChunks(text, 450);
      const chunkBuffers: ArrayBuffer[] = [];

      for (const chunk of textChunks) {
        const sonioxRes = await fetch('https://tts-rt.soniox.com/tts', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sonioxApiKey}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({
            text: chunk,
            model: 'tts-rt-v2',
            language: 'en',
            voice,
            audio_format: 'mp3',
            speed,
            reduce_silence: false,
          }),
        });

        if (!sonioxRes.ok) {
          throw new Error(`Soniox returned ${sonioxRes.status}`);
        }
        chunkBuffers.push(await sonioxRes.arrayBuffer());
      }

      // Concatenate MP3 chunks into one continuous audio track
      const totalBytes = chunkBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
      const combinedAudio = new Uint8Array(totalBytes);
      let offset = 0;
      for (const buf of chunkBuffers) {
        combinedAudio.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
      }

      const storageId = await ctx.storage.store(new Blob([combinedAudio.buffer], { type: 'audio/mpeg' }));

      // Everything past this point is wrapped separately so that a failure
      // here (Groq, the insert, or resolving the URL) deletes the blob we
      // just stored before falling through to the outer catch's browser
      // fallback -- otherwise a thrown error after a successful `store()`
      // orphans the file: no `audioTracks` row will ever reference it.
      try {
        // 6. Word timings via Groq Whisper for audio, falling back
        // to proportional linear distribution across the full text.
        let words: WordTiming[] = [];

        if (groqApiKey && combinedAudio.byteLength < 25 * 1024 * 1024) {
          try {
            const formData = new FormData();
            formData.append('file', new Blob([combinedAudio.buffer], { type: 'audio/mpeg' }), 'audio.mp3');
            formData.append('model', 'whisper-large-v3-turbo');
            formData.append('response_format', 'verbose_json');
            formData.append('timestamp_granularities[]', 'word');

            const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${groqApiKey}` },
              signal: AbortSignal.timeout(20000),
              body: formData,
            });

            if (groqRes.ok) {
              const groqData = (await groqRes.json()) as any;
              if (Array.isArray(groqData.words) && groqData.words.length > 0) {
                words = groqData.words
                  .map((w: any) => ({
                    text: String(w.word).trim(),
                    start: round(w.start, 3),
                    end: round(w.end, 3),
                  }))
                  .filter((w: WordTiming) => Boolean(w.text));
              }
            }
          } catch {
            // Groq unavailable -- fall through to linear distribution.
          }
        }

        // Fallback / Extension: If Whisper returned fewer words than total rawWords,
        // extrapolate remaining words so word timings span the entire article seamlessly.
        if (words.length < rawWords.length) {
          const lastSynthWord = words[words.length - 1];
          let curTime = lastSynthWord ? lastSynthWord.end : 0;
          const remainingWords = rawWords.slice(words.length);
          const remainingTimings = remainingWords.map((w) => {
            const start = curTime;
            const d = Math.max(0.18, Math.min(0.55, w.length * 0.048)) / speed;
            const end = start + d;
            curTime = end;
            return { text: w, start: round(start, 3), end: round(end, 3) };
          });
          words = [...words, ...remainingTimings];
        }

        let wordsTruncated = false;
        if (words.length > MAX_WORDS) {
          words = words.slice(0, MAX_WORDS);
          wordsTruncated = true;
          console.warn(
            `TTS words array truncated to ${MAX_WORDS} entries for article ${articleId} (voice ${voice}, speed ${speed})`
          );
        }

        const lastWord = words[words.length - 1];
        const duration = words.length > 0 && lastWord ? lastWord.end : 0;

        await ctx.runMutation(internal.routers.ttsInternal.insertAudioTrack, {
          articleId,
          voice,
          speed,
          storageId,
          duration,
          words,
        });

        const audioUrl: string | null = await ctx.storage.getUrl(storageId);
        if (!audioUrl) {
          throw new Error('Failed to resolve a URL for the stored audio file');
        }

        return {
          audioUrl,
          words,
          duration,
          provider: 'soniox' as const,
          cached: false,
          articleId,
          wordsTruncated,
        };
      } catch (postStoreErr) {
        await ctx.storage.delete(storageId).catch(() => {});
        throw postStoreErr;
      }
    } catch (err: any) {
      console.warn('Soniox neural synthesis fallback:', err);
      const { words, duration } = linearWordTimings(text);
      return {
        words,
        duration,
        provider: 'browser' as const,
        cached: false,
        warning: 'Speech synthesis fallback active: ' + (err?.message || String(err)),
      };
    }
  });
