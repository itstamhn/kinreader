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
const MAX_TTS_CHARS = 4000;
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
      wordsTruncated?: boolean;
    }
  | {
      words: WordTiming[];
      duration: number;
      provider: 'browser';
      cached: boolean;
      message?: string;
      warning?: string;
    };

function round(num: number, decimals = 3) {
  return Number(Math.round(Number(num + 'e' + decimals)) + 'e-' + decimals);
}

function linearWordTimings(text: string): { words: WordTiming[]; duration: number } {
  const rawWords = text.split(/\s+/).filter(Boolean);
  let curTime = 0;
  const words = rawWords.map((w) => {
    const start = curTime;
    const duration = Math.max(0.18, Math.min(0.55, w.length * 0.048));
    const end = start + duration;
    curTime = end;
    return { text: w, start: round(start), end: round(end) };
  });
  return { words, duration: round(curTime) };
}

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
      const audioUrl: string | null = await ctx.storage.getUrl(cached.storageId);
      if (audioUrl) {
        return {
          audioUrl,
          words: cached.words,
          duration: cached.duration,
          provider: 'soniox' as const,
          cached: true,
        };
      }
      // The stored file is gone (e.g. deleted out of band) -- fall through
      // and treat this as a miss so it regenerates.
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
      // 5. Generate Soniox TTS v2 audio.
      const sonioxRes = await fetch('https://tts-rt.soniox.com/tts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sonioxApiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(7000),
        body: JSON.stringify({
          text,
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

      const audioBuffer = await sonioxRes.arrayBuffer();
      const storageId = await ctx.storage.store(new Blob([audioBuffer], { type: 'audio/mpeg' }));

      // Everything past this point is wrapped separately so that a failure
      // here (Groq, the insert, or resolving the URL) deletes the blob we
      // just stored before falling through to the outer catch's browser
      // fallback -- otherwise a thrown error after a successful `store()`
      // orphans the file: no `audioTracks` row will ever reference it.
      try {
        // 6. Word timings via Groq Whisper, falling back to linear
        // distribution exactly as the old handler did.
        let words: WordTiming[] = [];

        if (groqApiKey) {
          try {
            const formData = new FormData();
            formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'audio.mp3');
            formData.append('model', 'whisper-large-v3-turbo');
            formData.append('response_format', 'verbose_json');
            formData.append('timestamp_granularities[]', 'word');

            const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${groqApiKey}` },
              signal: AbortSignal.timeout(5000),
              body: formData,
            });

            if (groqRes.ok) {
              const groqData = (await groqRes.json()) as any;
              if (Array.isArray(groqData.words)) {
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

        if (words.length === 0) {
          const rawWords = text.split(/\s+/).filter(Boolean);
          const estimatedTotalDuration = Math.max(1, rawWords.length * (0.28 / speed));
          const timePerWord = estimatedTotalDuration / rawWords.length;
          words = rawWords.map((w, idx) => ({
            text: w,
            start: round(idx * timePerWord, 3),
            end: round((idx + 1) * timePerWord, 3),
          }));
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
          wordsTruncated,
        };
      } catch (postStoreErr) {
        await ctx.storage.delete(storageId).catch(() => {});
        throw postStoreErr;
      }
    } catch (err) {
      console.warn('Soniox neural synthesis fallback:', err);
      const { words, duration } = linearWordTimings(text);
      return {
        words,
        duration,
        provider: 'browser' as const,
        cached: false,
        warning: 'Speech synthesis fallback active.',
      };
    }
  });
