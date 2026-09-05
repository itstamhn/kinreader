import { test, expect, afterEach } from 'bun:test';
import { convexTest } from 'convex-test';
import { v } from 'convex/values';
import schema from '../schema';
import { internal } from '../_generated/api';
import { api } from '../../shared/api';
import { internalAction } from '../_generated/server';
const modules = {
  './_generated/server.js': () => import('../_generated/server'),
  './audioPackaging.ts': () => import('../audioPackaging'),
  './routers/listening.ts': () => import('./listening'),
  './routers/listeningInternal.ts': () => import('./listeningInternal'),
  './routers/ingestionInternal.ts': () => import('./ingestionInternal'),
  './routers/ingestionWorker.ts': () => import('./ingestionWorker'),
  './routers/narration.ts': () => import('./narration'),
  './routers/narrationInternal.ts': () => import('./narrationInternal'),
  './routers/articlesInternal.ts': () => import('./articlesInternal'),
  './routers/ttsInternal.ts': () => import('./ttsInternal'),
  // Provider generation is deliberately replaced. No paid provider requests in tests.
  './routers/narrationWorker.ts': async () => ({ generate: internalAction({ args: { sectionId: v.id('narrationSections'), attempt: v.number() }, handler: async () => null }) }),
};
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const ownerToken = 'owner-token-'.repeat(4);
const input = { ownerToken, sourceUrl: 'https://example.com/article', voice: 'Adrian' };
function stub(content: string, status = 200) {
  global.fetch = (() => Promise.resolve(new Response(content, { status, headers: { 'Content-Type': 'text/html' } }))) as unknown as typeof fetch;
}
const article = '<main><p>' + 'Real article sentence with useful and readable information. '.repeat(30) + '</p></main>';
test('reserve returns one private ID before extraction, then server starts narration with no browser', async () => {
  const t = convexTest(schema, modules); let release!: (response: Response) => void;
  global.fetch = (() => new Promise<Response>(resolve => { release = resolve; })) as unknown as typeof fetch;
  const recordingId = await t.mutation(api.routers.listening.create, input);
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).stage).toBe('finding');
  expect(await t.mutation(api.routers.listening.create, input)).toBe(recordingId);
  await expect(t.query(api.routers.listening.get, { recordingId })).rejects.toThrow('private');
  // Complete the scheduled extraction, rather than invoking a browser narration callback.
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  release(new Response(article));
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.finishInProgressScheduledFunctions();
  const record = await t.query(api.routers.listening.get, { recordingId, ownerToken });
  expect(record.content).toContain('Real article'); expect(record.stage).toBe('preparing');
  expect(await t.run(ctx => ctx.db.query('narrationJobs').collect())).toHaveLength(1);
});
test('all extraction providers fail without creating an audio job', async () => {
  stub('', 404); const t = convexTest(schema, modules);
  const recordingId = await t.mutation(api.routers.listening.create, input);
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.finishInProgressScheduledFunctions();
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).stage).toBe('extractFailed');
  expect(await t.run(ctx => ctx.db.query('narrationJobs').collect())).toHaveLength(0);
});
test('uncertain capture requires approval even after cancel and retry', async () => {
  stub('<main><p>This is a brief article opening with enough words to review but not enough to be sure.</p></main>');
  const t = convexTest(schema, modules); const recordingId = await t.mutation(api.routers.listening.create, input);
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.finishInProgressScheduledFunctions();
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).stage).toBe('needsReview');
  await t.mutation(api.routers.listening.control, { recordingId, ownerToken, action: 'cancel' });
  await t.mutation(api.routers.listening.control, { recordingId, ownerToken, action: 'retry' });
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).stage).toBe('needsReview');
  expect(await t.run(ctx => ctx.db.query('narrationJobs').collect())).toHaveLength(0);
  await expect(t.mutation(api.routers.listening.control, { recordingId, action: 'approve' })).rejects.toThrow('private');
  await t.mutation(api.routers.listening.control, { recordingId, ownerToken, action: 'approve' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.finishInProgressScheduledFunctions();
  expect(await t.run(ctx => ctx.db.query('narrationJobs').collect())).toHaveLength(1);
});
test('stale extraction and watchdog cannot overwrite cancellation', async () => {
  const noWorker = { ...modules, './routers/ingestionWorker.ts': async () => ({ process: internalAction({ args: { recordingId: v.id('listeningRecords'), attempt: v.number() }, handler: async () => null }) }) };
  const t = convexTest(schema, noWorker); const recordingId = await t.mutation(api.routers.listening.create, input);
  await t.mutation(api.routers.listening.control, { recordingId, ownerToken, action: 'cancel' });
  expect(await t.mutation(internal.routers.ingestionInternal.capture, { recordingId, attempt: 1, title: 'Stale', content: 'Stale article', sourceType: 'article', truncated: false, needsReview: false })).toBe(false);
  await t.mutation(internal.routers.ingestionInternal.timeout, { recordingId, attempt: 1 });
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).stage).toBe('cancelled');
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.finishInProgressScheduledFunctions();
});
test('out-of-order audio is not playable, cancellation invalidates work, retry keeps finished sections', async () => {
  const t = convexTest(schema, modules);
  const recordingId = await t.mutation(api.routers.listening.create, { ownerToken, content: 'Many words for several audio sections. '.repeat(100), voice: 'Adrian' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.finishInProgressScheduledFunctions();
  const sections = await t.run(ctx => ctx.db.query('narrationSections').collect());
  const second = sections.find(s => s.index === 1)!;
  await t.run(async ctx => { await ctx.db.patch(second._id, { status: 'done' }); await ctx.db.patch(second.jobId, { completed: 1 }); });
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).openingReady).toBe(false);
  const first = sections.find(s => s.index === 0)!;
  await t.mutation(api.routers.listening.control, { recordingId, ownerToken, action: 'cancel' });
  expect(await t.query(internal.routers.narrationInternal.work, { sectionId: first._id, attempt: first.attempt })).toBeNull();
  await t.mutation(internal.routers.narrationInternal.fail, { sectionId: first._id, attempt: first.attempt, error: 'late callback' });
  expect((await t.run(ctx => ctx.db.get(second._id)))?.status).toBe('done');
  await t.mutation(api.routers.listening.control, { recordingId, ownerToken, action: 'retry' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.finishInProgressScheduledFunctions();
  expect((await t.run(ctx => ctx.db.get(second._id)))?.status).toBe('done');
  expect(await t.run(ctx => ctx.db.query('narrationJobs').collect())).toHaveLength(1);
});
test('opening an existing recording is read-only, including failed jobs', async () => {
  const t = convexTest(schema, modules);
  const recordingId = await t.mutation(api.routers.listening.create, { ownerToken, content: 'Private text.', voice: 'Adrian' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await t.finishInProgressScheduledFunctions();
  const before = await t.run(ctx => ctx.db.query('narrationJobs').first());
  await t.run(ctx => ctx.db.patch(before!._id, { status: 'failed' }));
  await t.action(api.routers.narration.prepare, { recordingId, ownerToken, text: 'Private text.', voice: 'Adrian', clientId: 'browser' });
  expect((await t.run(ctx => ctx.db.get(before!._id)))?.status).toBe('failed');
});

test('signed-in submission is discoverable on another device before worker completion', async () => {
  const noWorker = { ...modules, './routers/users.ts': () => import('./users'), './routers/ingestionWorker.ts': async () => ({ process: internalAction({ args: { recordingId: v.id('listeningRecords'), attempt: v.number() }, handler: async () => null }) }) };
  const t = convexTest(schema, noWorker);
  await t.run(ctx => ctx.db.insert('user', { name: 'Alice', email: 'alice@example.com', emailVerified: true, createdAt: 1, updatedAt: 1 }));
  const alice = t.withIdentity({ name: 'Alice', email: 'alice@example.com', tokenIdentifier: 'test|alice@example.com' });
  const recordingId = await alice.mutation(api.routers.listening.create, input);
  const entries = await alice.query(api.routers.users.getUserPlaylist, {});
  expect(entries).toHaveLength(1); expect(entries[0]!.article.recordingId).toBe(recordingId); expect((entries[0]!.article as any).stage).toBe('finding');
  await new Promise(resolve => setTimeout(resolve, 5)); await t.finishInProgressScheduledFunctions();
});
test('legacy saved recording discovers existing audio without generating new work', async () => {
  const t = convexTest(schema, modules);
  const recordingId = await t.run(ctx => ctx.db.insert('listeningRecords', { ownerToken, title: 'Old', content: 'Old captured text.', voice: 'Adrian', visibility: 'private', createdAt: 1 }));
  await t.run(ctx => ctx.db.insert('narrationJobs', { contentDigest: `${recordingId}:${'a'.repeat(64)}`, voice: 'Adrian', status: 'done', total: 1, completed: 1, createdAt: 1 }));
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).stage).toBe('complete');
  expect(await t.run(ctx => ctx.db.query('narrationJobs').collect())).toHaveLength(1);
});
test('retry watchdog checks the current handoff rather than a historical audio job ID', async () => {
  const noWorker = { ...modules, './routers/ingestionWorker.ts': async () => ({ process: internalAction({ args: { recordingId: v.id('listeningRecords'), attempt: v.number() }, handler: async () => null }) }) };
  const t = convexTest(schema, noWorker);
  const recordingId = await t.mutation(api.routers.listening.create, { ownerToken, content: 'Saved text.', voice: 'Adrian' });
  const jobId = await t.run(ctx => ctx.db.insert('narrationJobs', { contentDigest: `${recordingId}:${'a'.repeat(64)}`, voice: 'Adrian', status: 'cancelled', total: 1, completed: 0, createdAt: 1 }));
  await t.run(ctx => ctx.db.patch(recordingId, { stage: 'cancelled', narrationJobId: jobId, handoffAttempt: 1 }));
  await t.mutation(api.routers.listening.control, { recordingId, ownerToken, action: 'retry' });
  await t.mutation(internal.routers.ingestionInternal.timeout, { recordingId, attempt: 2 });
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).stage).toBe('audioFailed');
  expect((await t.run(ctx => ctx.db.get(recordingId)))?.narrationJobId).toBe(jobId);
  await new Promise(resolve => setTimeout(resolve, 5)); await t.finishInProgressScheduledFunctions();
});
test('long body-only landing text is reviewed rather than automatically narrated', async () => {
  stub('<body>' + 'Explore the site and discover more pages in our collection. '.repeat(30) + '</body>');
  const t = convexTest(schema, modules); const recordingId = await t.mutation(api.routers.listening.create, input);
  await new Promise(resolve => setTimeout(resolve, 5)); await t.finishInProgressScheduledFunctions();
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).stage).toBe('needsReview');
  expect(await t.run(ctx => ctx.db.query('narrationJobs').collect())).toHaveLength(0);
});
test('legacy running jobs are stopped when their owner cancels the recording', async () => {
  const t = convexTest(schema, modules);
  const recordingId = await t.run(ctx => ctx.db.insert('listeningRecords', { ownerToken, title: 'Old running', content: 'Old captured text.', voice: 'Adrian', visibility: 'private', createdAt: 1 }));
  const jobId = await t.run(ctx => ctx.db.insert('narrationJobs', { contentDigest: `${recordingId}:${'b'.repeat(64)}`, voice: 'Adrian', status: 'running', total: 1, completed: 0, createdAt: 1 }));
  const sectionId = await t.run(ctx => ctx.db.insert('narrationSections', { jobId, index: 0, text: 'Old captured text.', status: 'running', attempt: 1 }));
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).stage).toBe('preparing');
  await t.mutation(api.routers.listening.control, { recordingId, ownerToken, action: 'cancel' });
  expect((await t.run(ctx => ctx.db.get(jobId)))?.status).toBe('cancelled');
  const packaged = await t.query(internal.audioPackaging.page, { input: { recordingId, ownerToken, contentDigest: 'b'.repeat(64), voice: 'Adrian' }, from: 0 });
  expect(packaged.status).toBe('failed');
  expect(packaged.sections).toHaveLength(0);
  expect(await t.query(internal.routers.narrationInternal.work, { sectionId, attempt: 1 })).toBeNull();
});
