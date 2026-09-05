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
export const create = mutation.input(z.object({
  ownerToken: z.string().min(32).max(100), title: z.string().min(1).max(500), content: z.string().min(1).max(150000),
  author: z.string().max(500).optional(), sourceUrl: z.string().url().max(2048).optional(), image: z.string().url().max(2048).optional(),
  sourceType: z.enum(['article', 'x', 'text']).optional(), voice: z.string().min(1).max(100),
})).mutation(async ({ ctx, input }) => {
  const db = ctx.db as QueryCtx['db'] & MutationCtx['db'];
  const existing = await db.query('listeningRecords').withIndex('by_owner_token', q => q.eq('ownerToken', input.ownerToken)).unique();
  if (existing) return existing._id;
  const rate = await ctx.runMutation(internal.routers.articlesInternal.consumeExtractRateLimit, { key: await listeningOwner(ctx as MutationCtx) || input.ownerToken });
  if (!rate.ok) throw new Error('Too many article requests. Please try again shortly.');
  for (const url of [input.sourceUrl, input.image]) if (url && !/^https?:$/.test(new URL(url).protocol)) throw new Error('Only web links are supported.');
  return await db.insert('listeningRecords', { ...input, ownerId: await listeningOwner(ctx as MutationCtx), visibility: 'private', createdAt: Date.now() });
});
import { internal } from '../_generated/api';
export const get = query.input(accessInput).query(async ({ ctx, input }) => {
  const record = await accessibleRecording(ctx as unknown as QueryCtx, input);
  const owner = await listeningOwner(ctx as unknown as QueryCtx);
  const canManage = input.ownerToken === record.ownerToken || (!!owner && owner === record.ownerId);
  return { recordingId: record._id, title: record.title, author: record.author, content: record.content, sourceUrl: record.sourceUrl, sourceType: record.sourceType, image: record.image, voice: record.voice, visibility: record.visibility, canManage, ...(canManage ? { ownerToken: record.ownerToken } : {}) };
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
