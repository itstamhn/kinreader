import { test, expect } from 'bun:test';
import { convexTest } from 'convex-test';
import { internal } from '../_generated/api';
import { api } from '../../shared/api';
import schema from '../schema';
import { internalAction } from '../_generated/server';
import { v } from 'convex/values';

// Keep workers idle so tests control completion, timeout and retry ordering.
const modules = {
  './_generated/server.js': () => import('../_generated/server'),
  './routers/narration.ts': () => import('./narration'),
  './routers/narrationInternal.ts': () => import('./narrationInternal'),
  './routers/ttsInternal.ts': () => import('./ttsInternal'),
  './routers/narrationWorker.ts': async () => ({ generate: internalAction({ args: { sectionId: v.id('narrationSections'), attempt: v.number() }, handler: async () => null }) }),
};
const input = { contentDigest: 'a'.repeat(64), voice: 'Adrian', text: 'One whole sentence to be read aloud. '.repeat(1000), clientKey: 'test' };

test('long narration joins one job, saves a section, and ignores stale failure callbacks', async () => {
  const t = convexTest(schema, modules);
  const first = await t.mutation(internal.routers.narrationInternal.prepare, input);
  const second = await t.mutation(internal.routers.narrationInternal.prepare, input);
  expect(first).toBe(second);
  let rows = await t.run(ctx => ctx.db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', first)).collect());
  expect(rows.filter(s => s.status === 'running')).toHaveLength(2);
  expect(rows.map(s => s.text).join(' ').split(/\s+/).length).toBe(input.text.trim().split(/\s+/).length);
  const section = rows[0]!;
  const words = section.text.split(/\s+/).map((text, i) => ({ text, start: i * 0.4, end: i * 0.4 + 0.3 }));
  const storageId = await t.run(ctx => ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' })));
  expect(await t.mutation(internal.routers.narrationInternal.complete, { sectionId: section._id, attempt: 1, storageId, words, duration: words.length * 0.4 })).toBe(true);
  await t.mutation(internal.routers.narrationInternal.fail, { sectionId: section._id, attempt: 1, error: 'late timeout' });
  expect(await t.mutation(internal.routers.narrationInternal.complete, { sectionId: section._id, attempt: 1, storageId, words, duration: words.length * 0.4 })).toBe(false);
  const page = await t.query(api.routers.narration.page, { contentDigest: input.contentDigest, voice: input.voice, from: 0 });
  expect(page.completed).toBe(1);
  expect(page.sections).toHaveLength(1);
  expect(page.sections[0]!.words).toEqual(words);
  rows = await t.run(ctx => ctx.db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', first)).collect());
  expect(rows.filter(s => s.status === 'running')).toHaveLength(2);
  expect(rows[0]!.status).toBe('done');
  expect(await t.mutation(internal.routers.narrationInternal.prepare, input)).toBe(first);
  await t.finishInProgressScheduledFunctions();
});

test('out-of-order sections are withheld and retries preserve saved work', async () => {
  const t = convexTest(schema, modules);
  const jobId = await t.mutation(internal.routers.narrationInternal.prepare, input);
  const rows = await t.run(ctx => ctx.db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', jobId)).collect());
  const second = rows[1]!;
  const words = second.text.split(/\s+/).map((text, i) => ({ text, start: i, end: i + 0.5 }));
  const storageId = await t.run(ctx => ctx.storage.store(new Blob(['mp3'], { type: 'audio/mpeg' })));
  await t.mutation(internal.routers.narrationInternal.complete, { sectionId: second._id, attempt: 1, storageId, words, duration: words.length });
  expect((await t.query(api.routers.narration.page, { contentDigest: input.contentDigest, voice: input.voice, from: 0 })).sections).toEqual([]);
  for (const attempt of [1, 2, 3]) await t.mutation(internal.routers.narrationInternal.fail, { sectionId: rows[0]!._id, attempt, error: 'provider interrupted' });
  expect((await t.query(api.routers.narration.page, { contentDigest: input.contentDigest, voice: input.voice, from: 0 })).status).toBe('failed');
  await t.mutation(internal.routers.narrationInternal.prepare, input);
  const saved = await t.run(ctx => ctx.db.get(second._id));
  expect(saved?.storageId).toBe(storageId);
  expect(saved?.attempt).toBe(1);
  expect((await t.run(ctx => ctx.db.get(jobId)))?.completed).toBe(1);
  await t.finishInProgressScheduledFunctions();
});

test('different articles share the provider capacity and completed work releases a slot', async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.routers.narrationInternal.prepare, input);
  await t.mutation(internal.routers.narrationInternal.prepare, { ...input, contentDigest: 'b'.repeat(64) });
  const active = await t.run(ctx => ctx.db.query('narrationSections').withIndex('by_status', q => q.eq('status', 'running')).collect());
  expect(active).toHaveLength(2);
  await t.finishInProgressScheduledFunctions();
});

test('manual retry keeps increasing attempt tokens so old watchdogs cannot interrupt it', async () => {
  const t = convexTest(schema, modules);
  const jobId = await t.mutation(internal.routers.narrationInternal.prepare, input);
  const first = await t.run(ctx => ctx.db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', jobId)).first());
  for (const attempt of [1, 2, 3]) await t.mutation(internal.routers.narrationInternal.fail, { sectionId: first!._id, attempt, error: 'interrupted' });
  await t.mutation(internal.routers.narrationInternal.prepare, input);
  await t.mutation(internal.routers.narrationInternal.fail, { sectionId: first!._id, attempt: 1, error: 'stale watchdog' });
  const retried = await t.run(ctx => ctx.db.get(first!._id));
  expect(retried?.status).toBe('running');
  expect(retried?.attempt).toBe(4);
  await t.finishInProgressScheduledFunctions();
});

test('a long article does not monopolize provider slots when another article needs its opening', async () => {
  const t = convexTest(schema, modules);
  const firstJob = await t.mutation(internal.routers.narrationInternal.prepare, input);
  const newJob = await t.mutation(internal.routers.narrationInternal.prepare, { ...input, contentDigest: 'b'.repeat(64) });
  const first = (await t.run(ctx => ctx.db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', firstJob)).first()))!;
  const words = first.text.split(/\s+/).map((text, i) => ({ text, start: i, end: i + 0.5 }));
  const storageId = await t.run(ctx => ctx.storage.store(new Blob(['mp3'], { type: 'audio/mpeg' })));
  await t.mutation(internal.routers.narrationInternal.complete, { sectionId: first._id, attempt: 1, storageId, words, duration: words.length });
  const opening = await t.run(ctx => ctx.db.query('narrationSections').withIndex('by_jobId_and_index', q => q.eq('jobId', newJob)).first());
  expect(opening?.status).toBe('running');
  await t.finishInProgressScheduledFunctions();
});
