import { splitTextIntoSonioxChunks } from '../shared/soniox';

// The REST audio fallback behind `/api/tts/stream` (functions/http.ts). It is
// the path the reader takes when the browser-direct Soniox WebSocket cannot
// run (plan 022, Step 6), and until this module existed it was the one TTS
// entry point with no rate limiter, no length cap and `Access-Control-Allow-
// Origin: *` -- an open tap on SONIOX_API_KEY reachable on the convex.site
// origin by anyone. Everything here is pure request/response so it can be
// unit-tested without a Convex runtime; http.ts only supplies the limiter.

// Sized for a long essay (~3,500 words), not a book. Above this the reader is
// told to use on-device speech rather than the deployment paying for it.
export const MAX_REST_FALLBACK_CHARS = 20000;
export const MAX_CLIENT_ID_CHARS = 200;

const VOICE_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const SONIOX_REST_URL = 'https://tts-rt.soniox.com/tts';
const SONIOX_CHUNK_TIMEOUT_MS = 30000;

export interface TtsStreamRequestDeps {
  apiKey: string | undefined;
  allowedOrigins: readonly string[];
  /** Returns false when the caller has exhausted its budget. */
  consumeRateLimit(key: string): Promise<boolean>;
  fetcher?: typeof fetch;
}

type ParsedRequest =
  | { ok: true; text: string; voice: string; speed: number; clientId: string }
  | { ok: false; status: number; error: string };

function clampSpeed(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
  // Soniox accepts 0.7-1.3; the reader always asks for 1.0 and applies its own
  // playbackRate, so this clamp only matters for hand-written requests.
  return Math.max(0.7, Math.min(1.3, Number.isFinite(parsed) ? parsed : 1.0));
}

function normaliseClientId(raw: unknown): string {
  if (typeof raw !== 'string') return 'anonymous';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CLIENT_ID_CHARS) return 'anonymous';
  return trimmed;
}

async function parseRequest(req: Request): Promise<ParsedRequest> {
  let text: unknown;
  let voice: unknown;
  let speed: unknown;
  let clientId: unknown;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    text = url.searchParams.get('text');
    voice = url.searchParams.get('voice');
    speed = url.searchParams.get('speed');
    clientId = url.searchParams.get('clientId');
  } else {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return { ok: false, status: 400, error: 'Invalid JSON body' };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, status: 400, error: 'Invalid JSON body' };
    }
    const record = body as Record<string, unknown>;
    text = record.text;
    voice = record.voice;
    speed = record.speed;
    clientId = record.clientId;
  }

  const trimmedText = typeof text === 'string' ? text.trim() : '';
  if (!trimmedText) {
    return { ok: false, status: 400, error: 'Missing text' };
  }
  if (trimmedText.length > MAX_REST_FALLBACK_CHARS) {
    return {
      ok: false,
      status: 413,
      error: `Text exceeds the ${MAX_REST_FALLBACK_CHARS} character limit for REST synthesis`,
    };
  }

  const resolvedVoice = typeof voice === 'string' && voice.trim() ? voice.trim() : 'Adrian';
  if (!VOICE_PATTERN.test(resolvedVoice)) {
    return { ok: false, status: 400, error: 'Invalid voice' };
  }

  return {
    ok: true,
    text: trimmedText,
    voice: resolvedVoice,
    speed: clampSpeed(speed),
    clientId: normaliseClientId(clientId),
  };
}

// CORS is reflected only for known origins. The reader normally reaches this
// route same-origin through the Worker proxy (apps/web/src/worker.ts), so a
// missing `Origin` needs no CORS headers at all; a foreign origin gets none,
// which makes the browser refuse to hand it the bytes.
export function corsHeadersFor(req: Request, allowedOrigins: readonly string[]): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

function jsonError(status: number, error: string, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function fetchSonioxChunk(
  fetcher: typeof fetch,
  apiKey: string,
  chunk: string,
  voice: string,
  speed: number
): Promise<Response> {
  return fetcher(SONIOX_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(SONIOX_CHUNK_TIMEOUT_MS),
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
}

export async function handleTtsStreamRequest(req: Request, deps: TtsStreamRequestDeps): Promise<Response> {
  const cors = corsHeadersFor(req, deps.allowedOrigins);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const parsed = await parseRequest(req);
  if (!parsed.ok) return jsonError(parsed.status, parsed.error, cors);

  if (!deps.apiKey) {
    return jsonError(500, 'SONIOX_API_KEY not configured', cors);
  }

  // The limiter runs before the first upstream call, never after -- a denied
  // request must cost nothing.
  if (!(await deps.consumeRateLimit(parsed.clientId))) {
    return jsonError(429, 'Too many synthesis requests. Please try again in a minute.', {
      ...cors,
      'Retry-After': '60',
    });
  }

  const apiKey = deps.apiKey;
  const fetcher = deps.fetcher ?? fetch;
  const chunks = splitTextIntoSonioxChunks(parsed.text);

  // The first chunk is fetched before the response is committed so upstream
  // rejections still surface as an HTTP status the <audio> element (and the
  // reader's fallback chain) can react to. Later chunks stream as they
  // arrive: the article is one continuous MP3 to the client, and playback
  // starts after the first ~450 characters rather than after the whole text.
  let firstUpstream: Response;
  try {
    firstUpstream = await fetchSonioxChunk(fetcher, apiKey, chunks[0]!, parsed.voice, parsed.speed);
  } catch (err) {
    return jsonError(502, err instanceof Error ? err.message : 'Soniox streaming error', cors);
  }
  if (!firstUpstream.ok) {
    return jsonError(firstUpstream.status, `Soniox returned ${firstUpstream.status}`, cors);
  }

  let chunkIndex = 0;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null =
    firstUpstream.body?.getReader() ?? null;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!currentReader) {
            chunkIndex += 1;
            if (chunkIndex >= chunks.length) {
              controller.close();
              return;
            }
            const upstream = await fetchSonioxChunk(
              fetcher,
              apiKey,
              chunks[chunkIndex]!,
              parsed.voice,
              parsed.speed
            );
            if (!upstream.ok) throw new Error(`Soniox returned ${upstream.status}`);
            currentReader = upstream.body?.getReader() ?? null;
            if (!currentReader) continue;
          }
          const { done, value } = await currentReader.read();
          if (done) {
            currentReader = null;
            continue;
          }
          if (value && value.byteLength > 0) {
            controller.enqueue(value);
            return;
          }
        }
      } catch (err) {
        controller.error(err instanceof Error ? err : new Error('Soniox streaming error'));
      }
    },
    cancel() {
      currentReader?.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'audio/mpeg',
      // The body is per-request (voice, client) and paid for; nothing in front
      // of this route should hold onto it.
      'Cache-Control': 'no-store',
    },
  });
}
