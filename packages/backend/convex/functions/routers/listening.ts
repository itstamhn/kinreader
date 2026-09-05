import { z } from 'zod';
import { getSession } from 'kitcn/auth';
import { mutation, query } from '../crpc';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

export const accessInput = z.object({ recordingId: z.string().min(1), ownerToken: z.string().min(32).max(100).optional() });
export async function listeningOwner(ctx: QueryCtx | MutationCtx): Promise<string | undefined> {
  const session = await getSession(ctx);
  if (session?.userId) return String(session.userId);
  return (await ctx.auth.getUserIdentity())?.tokenIdentifier;
}
export async function accessibleRecording(ctx: QueryCtx | MutationCtx, input: { recordingId: string; ownerToken?: string }, manage = false): Promise<Doc<'listeningRecords'>> {
  const id = ctx.db.normalizeId('listeningRecords', input.recordingId);
  const record = id ? await ctx.db.get(id) : null;
  if (!record) throw new Error('This listening link is unavailable.');
  const owner = await listeningOwner(ctx);
  const owns = (!!input.ownerToken && input.ownerToken === record.ownerToken) || (!!owner && owner === record.ownerId);
  if (!owns && (manage || record.visibility !== 'link')) throw new Error('This recording is private or the link has been removed.');
  return record;
}
import { internal } from '../_generated/api';
import { assertPublicHttpUrl } from '../../lib/articleUrl';
import { snapshot, recordingProgress, recordingJob } from '../../lib/ingestion';

// Reserve the ID and its work in one transaction, before any remote request.
export const create = mutation.input(z.object({
  ownerToken: z.string().min(32).max(100), title: z.string().max(500).optional(), content: z.string().min(1).max(150000).optional(),
  author: z.string().max(500).optional(), sourceUrl: z.string().max(2048).optional(), image: z.string().url().max(2048).optional(),
  sourceType: z.enum(['article', 'x', 'text']).optional(), voice: z.string().min(1).max(100), clientId: z.string().max(200).optional(),
})).mutation(async ({ ctx, input }) => {
  const db = ctx.db as QueryCtx['db'] & MutationCtx['db'];
  const existing = await db.query('listeningRecords').withIndex('by_owner_token', q => q.eq('ownerToken', input.ownerToken)).unique();
  if (existing) return existing._id;
  const ownerId = await listeningOwner(ctx as MutationCtx);
  const rate = await ctx.runMutation(internal.routers.articlesInternal.consumeExtractRateLimit, { key: ownerId || input.clientId || 'anonymous' });
  if (!rate.ok) throw new Error('Too many article requests. Please try again shortly.');
  const sourceUrl = input.sourceUrl ? assertPublicHttpUrl(input.sourceUrl).toString() : undefined;
  if (!input.content?.trim() && !sourceUrl) throw new Error('Paste a link or some text.');
  const captured = input.content?.trim() ? snapshot(input.content) : { content: '' };
  const id = await db.insert('listeningRecords', {
    ownerToken: input.ownerToken, ownerId, title: input.title?.trim() || (sourceUrl ? new URL(sourceUrl).hostname : 'Pasted text'),
    ...captured, sourceUrl, author: input.author, image: input.image,
    sourceType: input.sourceType || (input.content ? 'text' : 'article'), voice: input.voice,
    visibility: 'private', createdAt: Date.now(), stage: input.content?.trim() ? 'preparing' : 'finding', attempt: 1,
  });
  // Account library membership is committed with the request, even if the browser disappears before acknowledgement.
  const identity = await ctx.auth.getUserIdentity();
  const ownerUserId = ownerId ? db.normalizeId('user', ownerId) : null;
  const user = ownerUserId ? await db.get(ownerUserId) : identity?.email ? await db.query('user').withIndex('email', q => q.eq('email', String(identity.email).toLowerCase())).first() : null;
  if (user) {
    const articleId = await db.insert('articles', { recordingId: id, url: `recording:${id}`, title: input.title || 'Preparing article', content: '', author: input.author || 'Article', sourceType: input.sourceType || 'article', wordCount: 0, createdAt: Date.now() });
    await db.insert('userArticles', { userId: user._id, articleId, progress: 0, lastWordIndex: 0, currentTime: 0, isCompleted: false, updatedAt: Date.now() });
  }
  await scheduleIngestion(ctx as MutationCtx, id, 1);
  return id;
});
async function scheduleIngestion(ctx: MutationCtx, recordingId: Doc<'listeningRecords'>['_id'], attempt: number) {
  await ctx.scheduler.runAfter(0, internal.routers.ingestionWorker.process, { recordingId, attempt });
  await ctx.scheduler.runAfter(90000, internal.routers.ingestionInternal.timeout, { recordingId, attempt });
}
export const control = mutation.input(accessInput.extend({ action: z.enum(['retry', 'approve', 'replace', 'cancel']), content: z.string().min(1).max(150000).optional() })).mutation(async ({ ctx, input }) => {
  const record = await accessibleRecording(ctx as MutationCtx, input, true);
  const attempt = (record.attempt || 0) + 1;
  const progress = await recordingProgress(ctx as unknown as QueryCtx, record);
  if (input.action === 'cancel') {
    const job = await recordingJob(ctx as unknown as QueryCtx, record);
    if (job) await ctx.runMutation(internal.routers.narrationInternal.cancel, { jobId: job._id });
    await ctx.db.patch(record._id, { stage: 'cancelled', attempt, error: undefined });
    return null;
  }
  if (input.action === 'approve' && record.stage !== 'needsReview') throw new Error('This article is not waiting for review.');
  if (input.action === 'replace' && !['needsReview', 'extractFailed'].includes(record.stage || '')) throw new Error('Create a new recording to change captured text.');
  if (input.action === 'retry' && !['extractFailed', 'audioFailed', 'cancelled'].includes(progress.stage)) throw new Error('This recording does not need a retry.');
  if (input.action === 'replace' && !input.content?.trim()) throw new Error('Paste the article text.');
  const captured = input.action === 'replace' ? snapshot(input.content!) : !record.narrationText && record.content ? snapshot(record.content) : undefined;
  const needsReview = input.action === 'retry' && record.needsReview === true;
  await ctx.db.patch(record._id, { ...(captured || {}), needsReview, stage: needsReview ? 'needsReview' : (captured?.content || record.content) ? 'preparing' : 'finding', attempt, error: undefined });
  if (!needsReview) await scheduleIngestion(ctx as MutationCtx, record._id, attempt);
  return null;
});
export const get = query.input(accessInput).query(async ({ ctx, input }) => {
  const record = await accessibleRecording(ctx as unknown as QueryCtx, input);
  const owner = await listeningOwner(ctx as unknown as QueryCtx);
  const canManage = input.ownerToken === record.ownerToken || (!!owner && owner === record.ownerId);
  return { recordingId: record._id, title: record.title, author: record.author, authorHandle: record.authorHandle, authorAvatar: record.authorAvatar, content: record.content, sourceUrl: record.sourceUrl, sourceType: record.sourceType, image: record.image, voice: record.voice, visibility: record.visibility, canManage, attempt: record.attempt, narrationText: record.narrationText, ...(await recordingProgress(ctx as unknown as QueryCtx, record)), ...(canManage ? { ownerToken: record.ownerToken } : {}) };
});
export const setVisibility = mutation.input(accessInput.extend({ visibility: z.enum(['private', 'link']) })).mutation(async ({ ctx, input }) => {
  const record = await accessibleRecording(ctx as MutationCtx, input, true);
  await ctx.db.patch(record._id, { visibility: input.visibility });
  return { recordingId: record._id, visibility: input.visibility };
});
export const claim = mutation.input(accessInput).mutation(async ({ ctx, input }) => {
  const record = await accessibleRecording(ctx as MutationCtx, input, true);
  const ownerId = await listeningOwner(ctx as MutationCtx);
  if (!ownerId) throw new Error('Sign in to save across devices.');
  if (record.ownerId && record.ownerId !== ownerId) throw new Error('This recording belongs to another account.');
  await ctx.db.patch(record._id, { ownerId });
  return null;
});
