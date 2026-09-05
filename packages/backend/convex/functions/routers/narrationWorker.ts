'use node';
import { v } from 'convex/values';
import WebSocket from 'ws';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { generateTrackWithSoniox } from '../../shared/tts/generateTrack';
import { mp3DurationSeconds } from '../../shared/tts/mp3Duration';
import type { SonioxSocketConstructor } from '../../shared/tts/sonioxStream';

export const generate = internalAction({
  args: { sectionId: v.id('narrationSections'), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const work = await ctx.runQuery(internal.routers.narrationInternal.work, args);
    if (!work) return null;
    try {
      const apiKey = process.env.SONIOX_API_KEY;
      if (!apiKey) throw new Error('Audio provider is not configured');
      const track = await generateTrackWithSoniox({ apiKey, text: work.section.text, voice: work.voice, segments: 1, timeoutMs: 120000, webSocket: WebSocket as unknown as SonioxSocketConstructor });
      const duration = mp3DurationSeconds(track.audio);
      if (duration <= 0) throw new Error('Audio provider returned invalid MP3');
      const storageId = await ctx.storage.store(new Blob([track.audio.buffer as ArrayBuffer], { type: 'audio/mpeg' }));
      try {
        const saved = await ctx.runMutation(internal.routers.narrationInternal.complete, { ...args, storageId, duration, words: track.words });
        if (!saved) await ctx.storage.delete(storageId);
      } catch (error) {
        await ctx.storage.delete(storageId);
        throw error;
      }
    } catch (error) {
      await ctx.runMutation(internal.routers.narrationInternal.fail, { ...args, error: error instanceof Error ? error.message : 'Audio preparation failed' });
    }
    return null;
  },
});
