import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { accessibleRecording } from './listening';
import schema from '../schema';
export const access = internalQuery({
  args: { recordingId: v.string(), ownerToken: v.optional(v.string()) },
  returns: schema.doc('listeningRecords'),
  handler: async (ctx, input) => accessibleRecording(ctx, input),
});
export const section = internalQuery({
  args: { recordingId: v.string(), ownerToken: v.optional(v.string()), sectionId: v.string() },
  returns: v.union(v.null(), v.id('_storage')),
  handler: async (ctx, input) => {
    const record = await accessibleRecording(ctx, input);
    const id = ctx.db.normalizeId('narrationSections', input.sectionId);
    const section = id ? await ctx.db.get(id) : null;
    if (!section || !section.storageId || section.status !== 'done') return null;
    const job = await ctx.db.get(section.jobId);
    if (!job?.contentDigest.startsWith(`${record._id}:`) || job.voice !== record.voice) return null;
    return section.storageId;
  },
});
export const metadata = internalQuery({
  args: { recordingId: v.string() },
  returns: v.union(v.null(), v.object({ title: v.string(), author: v.optional(v.string()), image: v.optional(v.string()) })),
  handler: async (ctx, input) => {
    const id = ctx.db.normalizeId('listeningRecords', input.recordingId);
    const record = id ? await ctx.db.get(id) : null;
    if (!record || record.visibility !== 'link') return null;
    return { title: record.title, author: record.author, image: record.image };
  },
});
