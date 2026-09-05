import type { Doc } from '../functions/_generated/dataModel';
import type { QueryCtx } from '../functions/_generated/server';
import { narrationText } from '../shared/tts/limits';
import { boundCapturedText } from './articleContent';
export function snapshot(content: string) {
  const captured = boundCapturedText(content);
  const spoken = narrationText(captured.text, { maxChars: 150000, maxWords: 30000 });
  return { content: captured.text, narrationText: spoken.text, truncated: captured.truncated || spoken.truncated };
}
export async function recordingProgress(ctx: QueryCtx, record: Doc<'listeningRecords'>) {
  const stage = record.stage || 'preparing';
  const job = await recordingJob(ctx, record);
  const first = job ? await ctx.db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', job._id).eq('index', 0)).unique() : null;
  const openingReady = first?.status === 'done';
  const status: NonNullable<Doc<'listeningRecords'>['stage']> | 'complete' | 'partial' = stage !== 'preparing' ? stage : !job && !record.stage ? 'audioFailed' : job?.status === 'done' ? 'complete' : job?.status === 'failed' ? 'audioFailed' : openingReady ? 'partial' : 'preparing';
  return { stage: status, openingReady, completed: job?.completed || 0, total: job?.total || 0, error: record.error, truncated: record.truncated || false };
}

export async function recordingJob(ctx: QueryCtx, record: Doc<'listeningRecords'>) {
  return record.narrationJobId ? await ctx.db.get(record.narrationJobId) : await ctx.db.query('narrationJobs').withIndex('by_contentDigest_and_voice', q => q.gte('contentDigest', `${record._id}:`).lt('contentDigest', `${record._id};`)).filter(q => q.eq(q.field('voice'), record.voice)).first();
}
