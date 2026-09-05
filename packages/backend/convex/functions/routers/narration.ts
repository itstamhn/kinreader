import { z } from 'zod';
import { action, query } from '../crpc';
import type { QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { DURABLE_NARRATION_MAX_CHARS, type NarrationPage } from '../../shared/tts/durableNarration';

export const prepare = action
  .input(z.object({ text: z.string().trim().min(1).max(DURABLE_NARRATION_MAX_CHARS), voice: z.string().trim().min(1).max(100), clientId: z.string().max(200), title: z.string().optional(), author: z.string().optional() }))
  .action(async ({ ctx, input }): Promise<{ status: 'scheduled' }> => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.text));
    const contentDigest = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    const identity = await ctx.auth.getUserIdentity();
    await ctx.runMutation(internal.routers.narrationInternal.prepare, { contentDigest, text: input.text, voice: input.voice, clientKey: identity?.tokenIdentifier || input.clientId || 'anonymous' });
    return { status: 'scheduled' };
  });

export const page = query
  .input(z.object({ contentDigest: z.string().regex(/^[0-9a-f]{64}$/), voice: z.string().min(1).max(100), from: z.number().int().min(0).max(1000) }))
  .query(async ({ ctx, input }): Promise<NarrationPage> => {
    const db = ctx.db as unknown as QueryCtx['db'];
    const job = await db.query('narrationJobs').withIndex('by_contentDigest_and_voice', q => q.eq('contentDigest', input.contentDigest).eq('voice', input.voice)).unique();
    if (!job) return { status: 'none', total: 0, completed: 0, error: null, sections: [] };
    const rows = await db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', job._id).gte('index', input.from)).take(4);
    const sections: NarrationPage['sections'] = [];
    let error: string | null = null;
    for (const row of rows) {
      if (row.status !== 'done' || !row.storageId || !row.words || !row.duration) { error = row.error ?? null; break; }
      const audioUrl = await ctx.storage.getUrl(row.storageId);
      if (!audioUrl) { error = 'Saved audio could not be found'; break; }
      sections.push({ index: row.index, audioUrl, words: row.words, duration: row.duration });
    }
    return { status: job.status, total: job.total, completed: job.completed, error, sections };
  });
