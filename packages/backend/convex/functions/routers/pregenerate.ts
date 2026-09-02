'use node';

import { v } from 'convex/values';
import WebSocket from 'ws';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { generateTrackWithSoniox } from '../../shared/tts/generateTrack';
import type { SonioxSocketConstructor } from '../../shared/tts/sonioxStream';
import { MAX_PREGENERATION_CHARS } from '../../shared/tts/limits';

// Server-side synthesis of a whole article into the global exact-track cache.
// Runs in the Node runtime because it needs a WebSocket client (Soniox's
// timestamps exist only on the WebSocket API); the default Convex runtime has
// no WebSocket. Scheduled by `tts.pregenerate` after that action has taken the
// (digest, voice) job slot, so this never races itself for the same article.
//
// The flow is deliberately the same as the reader's live stream -- the same
// parallel client, accumulator and MP3 handling -- so a pre-generated track and
// a streamed one are byte-for-byte the same kind of thing.

export const generate = internalAction({
  args: {
    contentDigest: v.string(),
    text: v.string(),
    title: v.optional(v.string()),
    author: v.optional(v.string()),
    voice: v.string(),
  },
  returns: v.union(v.literal('done'), v.literal('failed'), v.literal('skipped')),
  handler: async (ctx, args) => {
    const finish = async (status: 'done' | 'failed', error?: string) => {
      await ctx.runMutation(internal.routers.ttsInternal.completePregenerationJob, {
        contentDigest: args.contentDigest,
        voice: args.voice,
        status,
        ...(error ? { error } : {}),
      });
      return status;
    };

    const apiKey = process.env.SONIOX_API_KEY;
    if (!apiKey) return await finish('failed', 'SONIOX_API_KEY is not configured');

    const text = args.text.trim();
    if (!text || text.length > MAX_PREGENERATION_CHARS) {
      return await finish('failed', 'Text is empty or over the pre-generation limit');
    }

    // Another path (a signed-in listener persisting their stream, or an earlier
    // run) may have filled the cache in the meantime.
    const existing = await ctx.runQuery(internal.routers.ttsInternal.findGlobalExactTrack, {
      contentDigest: args.contentDigest,
      voice: args.voice,
    });
    if (existing) {
      await finish('done');
      return 'skipped';
    }

    let track;
    try {
      track = await generateTrackWithSoniox({
        apiKey,
        text,
        voice: args.voice,
        webSocket: WebSocket as unknown as SonioxSocketConstructor,
      });
    } catch (error) {
      console.warn('Pre-generation synthesis failed:', error);
      return await finish('failed', error instanceof Error ? error.message : 'Soniox synthesis failed');
    }

    const storageId = await ctx.storage.store(
      new Blob([track.audio.buffer as ArrayBuffer], { type: 'audio/mpeg' })
    );
    try {
      await ctx.runMutation(internal.routers.ttsInternal.finalizeGlobalExactTrack, {
        contentDigest: args.contentDigest,
        title: args.title,
        author: args.author,
        content: text,
        voice: args.voice,
        storageId,
        duration: track.duration,
        words: track.words,
      });
    } catch (error) {
      // Nothing references the blob; do not leave it orphaned.
      await ctx.storage.delete(storageId).catch(() => {});
      console.warn('Pre-generation finalize failed:', error);
      return await finish('failed', error instanceof Error ? error.message : 'Finalize failed');
    }

    return await finish('done');
  },
});
