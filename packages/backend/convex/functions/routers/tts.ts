import { z } from 'zod';
import { action, mutation, query } from '../crpc';
import { internal } from '../_generated/api';
import { env } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { splitTextIntoSonioxChunks } from '../../shared/soniox';

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
const MAX_SONIOX_REST_SYNTH_CHARS = 900;

type WordTiming = { text: string; start: number; end: number };

const wordTimingSchema = z.object({
  text: z.string().min(1),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
});

const exactTrackSchema = z.object({
  audioUrl: z.string().min(1),
  words: z.array(wordTimingSchema).max(MAX_WORDS),
  duration: z.number().finite().positive(),
  timingsSource: z.literal('soniox'),
});

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

// The WebSocket transport streams the complete accepted article. The legacy
// REST fallback remains intentionally capped until its compatibility path can
// be retired, so it cannot accidentally regain the browser transport's cost
// profile.
function splitTextIntoRestSonioxChunks(fullText: string): string[] {
  const trimmed = fullText.trim();
  if (trimmed.length <= MAX_SONIOX_REST_SYNTH_CHARS) {
    return splitTextIntoSonioxChunks(trimmed);
  }

  const rawSlice = trimmed.slice(0, MAX_SONIOX_REST_SYNTH_CHARS);
  const lastBoundary = Math.max(
    rawSlice.lastIndexOf('. '),
    rawSlice.lastIndexOf('! '),
    rawSlice.lastIndexOf('? '),
    rawSlice.lastIndexOf('.\n'),
    rawSlice.lastIndexOf('\n')
  );
  const cappedText = lastBoundary > 300 ? rawSlice.slice(0, lastBoundary + 1).trim() : rawSlice.trim();
  return splitTextIntoSonioxChunks(cappedText);
}

type TemporaryKeyResult = { apiKey: string; expiresAt: string };

type TrackUploadGrantIssue =
  | { ok: false }
  | { ok: true; grant: string; expiresAt: number };

export async function allocateTrackUploadAfterGrant(
  issueGrant: () => Promise<TrackUploadGrantIssue>,
  allocateUploadUrl: () => Promise<string>
): Promise<{ uploadUrl: string; grant: string; expiresAt: number }> {
  const issuance = await issueGrant();
  if (!issuance.ok) {
    throw new Error('Too many track upload requests. Please try again in a minute.');
  }

  const uploadUrl = await allocateUploadUrl();
  return { uploadUrl, grant: issuance.grant, expiresAt: issuance.expiresAt };
}

function isTemporaryKeyResponse(value: unknown): value is { api_key: string; expires_at: string } {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (
    typeof response.api_key !== 'string' ||
    response.api_key.length === 0 ||
    typeof response.expires_at !== 'string'
  ) return false;

  const expiresAt = Date.parse(response.expires_at);
  const now = Date.now();
  return Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + 10 * 60 * 1000;
}

// The client's cache key ends in the article's content digest whether or not
// it has a source URL (apps/web/src/utils/articleCacheKey.ts). The global
// cache is keyed on that digest alone: the same text is the same audio
// wherever it came from.
const CONTENT_DIGEST_SUFFIX = /content-sha256:([0-9a-f]{64})$/;

function contentDigestFromCacheKey(cacheKey: string): string | null {
  return CONTENT_DIGEST_SUFFIX.exec(cacheKey)?.[1] ?? null;
}

export const getExactTrack = query
  .input(
    z.object({
      url: z.string().trim().min(1).max(4096),
      voice: z.string().trim().min(1).max(100),
    })
  )
  .output(exactTrackSchema.nullable())
  .query(async ({ ctx, input }) => {
    // 1. The global cache: server-generated tracks, readable by anyone.
    const contentDigest = contentDigestFromCacheKey(input.url);
    let track: Doc<'audioTracks'> | null = null;
    if (contentDigest) {
      track = await ctx.runQuery(internal.routers.ttsInternal.findGlobalExactTrack, {
        contentDigest,
        voice: input.voice,
      });
    }

    // 2. The listener's own persisted streams, when signed in.
    if (!track) {
      const identity = await ctx.auth?.getUserIdentity?.();
      if (!identity) return null;
      track = await ctx.runQuery(internal.routers.ttsInternal.findExactCachedTrackByUrl, {
        ownerKey: identity.tokenIdentifier,
        cacheKey: input.url,
        voice: input.voice,
      });
    }
    if (!track?.storageId) return null;

    const audioUrl = await ctx.storage.getUrl(track.storageId);
    if (!audioUrl) return null;
    return {
      audioUrl,
      words: track.words,
      duration: track.duration,
      timingsSource: 'soniox' as const,
    };
  });

type PregenerateStatus = 'ready' | 'running' | 'scheduled' | 'skipped';

// Start synthesising an article into the global cache before anyone presses
// Play -- called when an article is extracted or added to the queue. Paid
// work, so it runs through the same limiters as every other Soniox path, and
// the (digest, voice) job slot stops duplicate requests from paying twice.
export const pregenerate = action
  .input(
    z.object({
      title: z.string().max(500).optional(),
      author: z.string().max(500).optional(),
      text: z.string().trim().min(1).max(MAX_TTS_CHARS),
      voice: z.string().trim().min(1).max(100).optional(),
      clientId: z.string().trim().min(1).max(200).optional(),
    })
  )
  .action(async ({ ctx, input }): Promise<{ status: PregenerateStatus }> => {
    const text = input.text.trim();
    const voice = input.voice || 'Adrian';
    if (text.split(/\s+/).filter(Boolean).length > MAX_WORDS) return { status: 'skipped' };

    const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const contentDigest = Array.from(new Uint8Array(digestBytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

    const existing: Doc<'audioTracks'> | null = await ctx.runQuery(
      internal.routers.ttsInternal.findGlobalExactTrack,
      { contentDigest, voice }
    );
    if (existing) return { status: 'ready' };

    const identity = await ctx.auth?.getUserIdentity?.();
    const rateLimit: { ok: boolean } = await ctx.runMutation(internal.routers.ttsInternal.consumeTtsRateLimit, {
      key: identity?.tokenIdentifier || input.clientId || 'anonymous',
      purpose: 'synthesize',
    });
    if (!rateLimit.ok) return { status: 'skipped' };

    const claim: 'claimed' | 'running' | 'done' = await ctx.runMutation(
      internal.routers.ttsInternal.claimPregenerationJob,
      { contentDigest, voice }
    );
    if (claim === 'done') return { status: 'ready' };
    if (claim === 'running') return { status: 'running' };

    await ctx.scheduler.runAfter(0, internal.routers.pregenerate.generate, {
      contentDigest,
      text,
      title: input.title,
      author: input.author,
      voice,
    });
    return { status: 'scheduled' };
  });

export const generateTrackUploadUrl = mutation
  .input(
    z.object({
      cacheKey: z.string().trim().min(1).max(5000),
      contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
      voice: z.string().trim().min(1).max(100),
    })
  )
  .output(
    z.object({
      uploadUrl: z.string().min(1),
      grant: z.string().min(64).max(200),
      expiresAt: z.number().int().positive(),
    })
  )
  .mutation(async ({ ctx, input }) => {
    const identity = await ctx.auth?.getUserIdentity?.();
    if (!identity) throw new Error('Sign in is required to persist exact tracks');
    const ownerKey = identity.tokenIdentifier;
    const grantToken = `${crypto.randomUUID().replaceAll('-', '')}${crypto
      .randomUUID()
      .replaceAll('-', '')}`;
    const expiresAt = Date.now() + 10 * 60 * 1000;

    return await allocateTrackUploadAfterGrant(
      () =>
        ctx.runMutation(internal.routers.ttsInternal.issueTrackUploadGrant, {
          ownerKey,
          cacheKey: input.cacheKey,
          contentDigest: input.contentDigest,
          voice: input.voice,
          token: grantToken,
          expiresAt,
        }) as Promise<TrackUploadGrantIssue>,
      () => ctx.storage.generateUploadUrl()
    );
  });

export const persistTrack = mutation
  .input(
    z.object({
      url: z.string().trim().min(1).max(4096),
      title: z.string().max(500).optional(),
      author: z.string().max(500).optional(),
      text: z.string().trim().min(1).max(MAX_TTS_CHARS),
      voice: z.string().trim().min(1).max(100),
      grant: z.string().min(64).max(200),
      storageId: z.string().min(1),
      duration: z.number().finite().positive(),
      words: z.array(wordTimingSchema).max(MAX_WORDS),
    })
  )
  .output(
    z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), articleId: z.string(), trackId: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
  )
  .mutation(async ({ ctx, input }) => {
    const identity = await ctx.auth?.getUserIdentity?.();
    if (!identity) throw new Error('Sign in is required to persist exact tracks');
    const finalizeInput = {
      ownerKey: identity.tokenIdentifier,
      cacheKey: input.url,
      title: input.title,
      author: input.author,
      content: input.text,
      voice: input.voice,
      grant: input.grant,
      storageId: input.storageId as Id<'_storage'>,
      duration: input.duration,
      words: input.words,
    };
    try {
      const result = await ctx.runMutation(
        internal.routers.ttsInternal.finalizeExactTrack,
        finalizeInput
      );
      return { ok: true as const, ...result };
    } catch (error) {
      try {
        await ctx.runMutation(internal.routers.ttsInternal.rejectExactTrackUpload, {
          ownerKey: identity.tokenIdentifier,
          cacheKey: input.url,
          content: input.text,
          voice: input.voice,
          grant: input.grant,
          storageId: input.storageId as Id<'_storage'>,
        });
      } catch {
        // A blob without the owner-bound grant marker cannot be deleted safely.
      }
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'Exact track finalization failed',
      };
    }
  });

export const temporaryKey = action
  .input(z.object({ clientId: z.string().trim().min(1).max(200).optional() }))
  .action(async ({ ctx, input }): Promise<TemporaryKeyResult> => {
    const sonioxApiKey = env.SONIOX_API_KEY;
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
          // The reader opens several concurrent sessions per article
          // (apps/web/src/utils/parallelSoniox.ts) on one key. The 300s
          // expiry and the limiters above bound what a leaked key is worth.
          single_use: false,
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
      const textChunks = splitTextIntoRestSonioxChunks(text);
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
          timingsSource: 'estimated',
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
