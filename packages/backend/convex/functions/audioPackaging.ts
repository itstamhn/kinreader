import { v } from 'convex/values';
import { Workpool } from '@convex-dev/workpool';
import { internalMutation, internalQuery, internalAction, env } from './_generated/server';
import { internal, components } from './_generated/api';
import type { NarrationPage } from '../shared/tts/durableNarration';

export const source = v.object({ contentDigest: v.string(), voice: v.string(), recordingId: v.optional(v.string()), ownerToken: v.optional(v.string()) });
const pool = new Workpool(components.audioPackagingPool, { maxParallelism: 2, retryActionsByDefault: false });

export const start = internalMutation({
  args: { key: v.string(), input: source },
  handler: async (ctx, args): Promise<{ generation: string }> => {
    const existing = await ctx.db.query('audioPackagingJobs').withIndex('by_key', q => q.eq('key', args.key)).unique();
    if (existing && (existing.status === 'done' || existing.status === 'queued' || existing.leaseUntil > Date.now())) return { generation: existing.generation };
    const generation = crypto.randomUUID().replaceAll('-', '');
    const data = { key: args.key, generation, status: 'queued' as const, leaseUntil: 0 };
    if (existing) await ctx.db.patch(existing._id, data);
    else await ctx.db.insert('audioPackagingJobs', data);
    await pool.enqueueAction(ctx, internal.audioPackagingNode.convert, { ...args, generation }, { retry: false, onComplete: internal.audioPackaging.onComplete, context: { key: args.key, generation } });
    return { generation };
  },
});
export const claim = internalMutation({
  args: { key: v.string(), generation: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query('audioPackagingJobs').withIndex('by_key', q => q.eq('key', args.key)).unique();
    if (!row || row.generation !== args.generation || row.status !== 'queued') return false;
    await ctx.db.patch(row._id, { status: 'running', leaseUntil: Date.now() + 12 * 60000 });
    return true;
  },
});
export const finish = internalMutation({
  args: { key: v.string(), generation: v.string(), ok: v.boolean() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query('audioPackagingJobs').withIndex('by_key', q => q.eq('key', args.key)).unique();
    if (row?.generation === args.generation) await ctx.db.patch(row._id, { status: args.ok ? 'done' : 'failed', leaseUntil: args.ok ? 0 : Date.now() + 30000 });
  },
});
export const page = internalQuery({
  args: { input: source, from: v.number() },
  handler: async (ctx, { input, from }): Promise<NarrationPage> => {
    const digest = input.recordingId ? `${input.recordingId}:${input.contentDigest}` : input.contentDigest;
    const job = await ctx.db.query('narrationJobs').withIndex('by_contentDigest_and_voice', q => q.eq('contentDigest', digest).eq('voice', input.voice)).unique();
    if (!job) throw new Error('Recording unavailable');
    const rows = await ctx.db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', job._id).gte('index', from)).take(4);
    const sections: NarrationPage['sections'] = [];
    for (const row of rows) {
      if (row.status !== 'done' || !row.storageId || !row.words || !row.duration) break;
      const audioUrl = await ctx.storage.getUrl(row.storageId);
      if (!audioUrl) throw new Error('Saved audio unavailable');
      sections.push({ index: row.index, duration: row.duration, words: row.words, audioUrl });
    }
    return { status: job.status === 'running' || job.status === 'done' ? job.status : 'failed', total: job.total, completed: job.completed, sections, error: null };
  },
});

export const onComplete = internalMutation({
  args: {
    workId: v.string(), context: v.object({ key: v.string(), generation: v.string() }),
    result: v.union(v.object({ kind: v.literal('success'), returnValue: v.null() }),
      v.object({ kind: v.literal('failed'), error: v.string() }), v.object({ kind: v.literal('canceled') })),
  },
  handler: async (ctx, { context, result }) => {
    if (result.kind === 'success') return;
    const row = await ctx.db.query('audioPackagingJobs').withIndex('by_key', q => q.eq('key', context.key)).unique();
    if (row?.generation !== context.generation) return;
    await ctx.db.patch(row._id, { status: 'failed', leaseUntil: 0 });
    await ctx.scheduler.runAfter(0, internal.audioPackaging.reportFailure, context);
  },
});
export const reportFailure = internalAction({
  args: { key: v.string(), generation: v.string() },
  handler: async (_ctx, args) => {
    if (!env.AUDIO_PACKAGER_ORIGIN || !env.AUDIO_PACKAGER_SECRET) return;
    await fetch(`${env.AUDIO_PACKAGER_ORIGIN}/internal/objects/${args.key}/${args.generation}/error.json`, {
      method: 'PUT', headers: { Authorization: `Bearer ${env.AUDIO_PACKAGER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Continuous audio could not be prepared. Please retry.' }), signal: AbortSignal.timeout(10000),
    });
  },
});
