import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx, env } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { NARRATION_CONCURRENCY, NARRATION_LEASE_MS, planNarrationSections } from '../../shared/tts/durableNarration';
import schema from '../schema';

async function scheduleCompletedPackaging(ctx: MutationCtx, job: Doc<'narrationJobs'>) {
  try {
    if (!env.AUDIO_PACKAGER_ORIGIN || !env.AUDIO_PACKAGER_SECRET) return;
    const separator = job.contentDigest.lastIndexOf(':');
    if (separator < 1) return;
    const recordingId = job.contentDigest.slice(0, separator);
    const contentDigest = job.contentDigest.slice(separator + 1);
    if (!/^[a-f0-9]{64}$/.test(contentDigest)) return;
    const input = { contentDigest, voice: job.voice, recordingId };
    const bytes = new TextEncoder().encode(JSON.stringify([contentDigest, job.voice, recordingId]));
    const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    await ctx.runMutation(internal.audioPackaging.start, { key, input });
  } catch { /* Saved MP3 completion is authoritative. */ }
}

async function schedule(ctx: MutationCtx, section: Doc<'narrationSections'>, delay = 0) {
  const attempt = section.attempt + 1;
  await ctx.db.patch(section._id, { status: 'running', attempt, error: undefined });
  await ctx.scheduler.runAfter(delay, internal.routers.narrationWorker.generate, { sectionId: section._id, attempt });
  await ctx.scheduler.runAfter(delay + NARRATION_LEASE_MS, internal.routers.narrationInternal.fail, {
    sectionId: section._id, attempt, error: 'Audio preparation timed out',
  });
}

// The provider limit is shared by the account, not by each article.
async function pump(ctx: MutationCtx) {
  const active = await ctx.db.query('narrationSections').withIndex('by_status', q => q.eq('status', 'running')).take(NARRATION_CONCURRENCY);
  let slots = NARRATION_CONCURRENCY - active.length;
  if (slots <= 0) return;
  const jobs = await ctx.db.query('narrationJobs').withIndex('by_status', q => q.eq('status', 'running')).take(32);
  // Give newly added articles their opening audio before extending a long buffer.
  jobs.sort((a, b) => a.completed - b.completed || a.createdAt - b.createdAt);
  for (const job of jobs) {
    const next = await ctx.db.query('narrationSections').withIndex('by_jobId_and_status', q => q.eq('jobId', job._id).eq('status', 'queued')).take(slots);
    for (const section of next) await schedule(ctx, section);
    slots -= next.length;
    if (slots <= 0) return;
  }
}

export const prepare = internalMutation({
  args: { contentDigest: v.string(), text: v.string(), voice: v.string(), clientKey: v.string() },
  returns: v.id('narrationJobs'),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query('narrationJobs')
      .withIndex('by_contentDigest_and_voice', q => q.eq('contentDigest', args.contentDigest).eq('voice', args.voice)).unique();
    if (existing && !['failed', 'cancelled'].includes(existing.status)) { await pump(ctx); return existing._id; }
    const rate: { ok: boolean } = await ctx.runMutation(internal.routers.ttsInternal.consumeTtsRateLimit, {
      key: args.clientKey, purpose: 'synthesize',
    });
    if (!rate.ok) throw new Error('Audio preparation is busy. Please try again in a minute.');
    if (existing) {
      // A retry preserves every saved section. Only failed work is requeued.
      const failed = await ctx.db.query('narrationSections').withIndex('by_jobId_and_status', q => q.eq('jobId', existing._id).eq('status', 'failed')).collect();
      for (const section of failed) await ctx.db.patch(section._id, { status: 'queued', error: undefined });
      await ctx.db.patch(existing._id, { status: 'running' });
      await pump(ctx);
      return existing._id;
    }
    const texts = planNarrationSections(args.text);
    const jobId = await ctx.db.insert('narrationJobs', { contentDigest: args.contentDigest, voice: args.voice, status: 'running', total: texts.length, completed: 0, createdAt: Date.now() });
    for (const [index, text] of texts.entries()) {
      await ctx.db.insert('narrationSections', { jobId, index, text, status: 'queued', attempt: 0 });
    }
    await pump(ctx);
    return jobId;
  },
});

export const work = internalQuery({
  args: { sectionId: v.id('narrationSections'), attempt: v.number() },
  returns: v.union(v.null(), v.object({ section: schema.doc('narrationSections'), voice: v.string() })),
  handler: async (ctx, args) => {
    const section = await ctx.db.get(args.sectionId);
    if (!section || section.status !== 'running' || section.attempt !== args.attempt) return null;
    const job = await ctx.db.get(section.jobId);
    return job && job.status === 'running' ? { section, voice: job.voice } : null;
  },
});

export const complete = internalMutation({
  args: { sectionId: v.id('narrationSections'), attempt: v.number(), storageId: v.id('_storage'), duration: v.number(), words: v.array(v.object({ text: v.string(), start: v.number(), end: v.number() })) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const section = await ctx.db.get(args.sectionId);
    if (!section || section.status !== 'running' || section.attempt !== args.attempt) return false;
    const job = await ctx.db.get(section.jobId);
    if (!job || job.status === 'cancelled') return false;
    const expected = section.text.split(/\s+/);
    if (args.words.length !== expected.length || args.words.some((w, i) => w.text !== expected[i] || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end <= w.start || w.end > args.duration + 0.05 || (i > 0 && w.start < args.words[i - 1]!.end))) throw new Error('Incomplete or invalid section timings');
    if (!Number.isFinite(args.duration) || args.duration <= 0 || !(await ctx.db.system.get(args.storageId))) throw new Error('Missing section audio');
    await ctx.db.patch(section._id, { status: 'done', storageId: args.storageId, words: args.words, duration: args.duration, error: undefined });
    const finished = job.status === 'running' && job.completed + 1 === job.total;
    await ctx.db.patch(job._id, { completed: job.completed + 1, ...(finished ? { status: 'done' as const } : {}) });
    if (finished) await scheduleCompletedPackaging(ctx, job);
    await pump(ctx);
    return true;
  },
});

export const fail = internalMutation({
  args: { sectionId: v.id('narrationSections'), attempt: v.number(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const section = await ctx.db.get(args.sectionId);
    if (!section || section.status !== 'running' || section.attempt !== args.attempt) return null;
    if (args.error.includes('limit_exceeded') && section.attempt < 20) await schedule(ctx, section, 30000);
    else if (section.attempt % 3 !== 0) await schedule(ctx, section, 5000 * (section.attempt % 3));
    else {
      await ctx.db.patch(section._id, { status: 'failed', error: args.error.slice(0, 300) });
      await ctx.db.patch(section.jobId, { status: 'failed' });
    }
    await pump(ctx);
    return null;
  },
});

export const cancel = internalMutation({ args: { jobId: v.id('narrationJobs') }, returns: v.null(), handler: async (ctx, args) => {
  const job = await ctx.db.get(args.jobId);
  if (!job || job.status === 'done') return null;
  const sections = await ctx.db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', job._id)).take(1000);
  for (const section of sections) if (section.status !== 'done') await ctx.db.patch(section._id, { status: 'failed', attempt: section.attempt + 1, error: 'Preparation cancelled' });
  await ctx.db.patch(job._id, { status: 'cancelled' });
  await pump(ctx);
  return null;
} });
