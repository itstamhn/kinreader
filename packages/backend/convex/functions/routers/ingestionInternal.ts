import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import schema from '../schema';
import { snapshot } from '../../lib/ingestion';
const workArgs = { recordingId: v.id('listeningRecords'), attempt: v.number() };
export const work = internalQuery({ args: workArgs, returns: v.union(v.null(), schema.doc('listeningRecords')), handler: async (ctx, args) => {
  const record = await ctx.db.get(args.recordingId);
  return record && record.attempt === args.attempt && ['finding', 'preparing'].includes(record.stage || '') ? record : null;
} });
export const capture = internalMutation({
  args: { ...workArgs, title: v.string(), content: v.string(), author: v.optional(v.string()), authorHandle: v.optional(v.string()), authorAvatar: v.optional(v.string()), image: v.optional(v.string()), sourceType: v.union(v.literal('x'), v.literal('article')), truncated: v.boolean(), needsReview: v.boolean(), reviewReason: v.optional(v.string()) },
  returns: v.boolean(), handler: async (ctx, args) => {
    const record = await ctx.db.get(args.recordingId);
    if (!record || record.attempt !== args.attempt || record.stage !== 'finding') return false;
    const captured = snapshot(args.content);
    await ctx.db.patch(record._id, { ...captured, needsReview: args.needsReview, authorHandle: args.authorHandle, authorAvatar: args.authorAvatar, title: args.title.slice(0, 500), author: args.author?.slice(0, 500), image: args.image?.slice(0, 2048), sourceType: args.sourceType,
      truncated: args.truncated || captured.truncated, stage: args.needsReview ? 'needsReview' : 'preparing', error: args.reviewReason });
    return !args.needsReview;
  },
});
export const prepare = internalMutation({ args: { ...workArgs, digest: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const record = await ctx.db.get(args.recordingId);
  if (!record || record.attempt !== args.attempt || record.stage !== 'preparing' || !record.narrationText) return null;
  try {
    const narrationJobId = await ctx.runMutation(internal.routers.narrationInternal.prepare, { contentDigest: `${record._id}:${args.digest}`, text: record.narrationText, voice: record.voice, clientKey: record.ownerId || record.ownerToken });
    await ctx.db.patch(record._id, { narrationJobId, handoffAttempt: args.attempt, error: undefined });
  } catch {
    await ctx.db.patch(record._id, { stage: 'audioFailed', error: 'Audio preparation could not start. Try again shortly.' });
  }
  return null;
} });
export const fail = internalMutation({ args: { ...workArgs, error: v.string() }, returns: v.null(), handler: async (ctx, args) => {
  const record = await ctx.db.get(args.recordingId);
  if (record && record.attempt === args.attempt && ['finding', 'preparing'].includes(record.stage || '') && record.handoffAttempt !== args.attempt) await ctx.db.patch(record._id, { stage: record.content ? 'audioFailed' : 'extractFailed', error: args.error.slice(0, 300) });
  return null;
} });
export const timeout = internalMutation({ args: workArgs, returns: v.null(), handler: async (ctx, args) => {
  const record = await ctx.db.get(args.recordingId);
  if (record && record.attempt === args.attempt && ['finding', 'preparing'].includes(record.stage || '') && record.handoffAttempt !== args.attempt) await ctx.db.patch(record._id, { stage: record.content ? 'audioFailed' : 'extractFailed', attempt: args.attempt + 1, error: 'Preparation timed out. Your request is saved. Try again.' });
  return null;
} });
