import { expect, test } from 'bun:test';
import { convexTest } from 'convex-test';
import { internal } from '../_generated/api';
import { api } from '../../shared/api';
import schema from '../schema';
import { internalAction } from '../_generated/server';
import { v } from 'convex/values';
import { listeningAudioResponse } from '../../lib/listeningAudio';
const modules = {
  './_generated/server.js': () => import('../_generated/server'),
  './routers/listening.ts': () => import('./listening'),
  './routers/listeningInternal.ts': () => import('./listeningInternal'),
  './routers/narration.ts': () => import('./narration'),
  './routers/narrationInternal.ts': () => import('./narrationInternal'),
  './routers/ttsInternal.ts': () => import('./ttsInternal'),
  './routers/articlesInternal.ts': () => import('./articlesInternal'),
  './routers/narrationWorker.ts': async () => ({ generate: internalAction({ args: { sectionId: v.id('narrationSections'), attempt: v.number() }, handler: async () => null }) }),
};
const ownerToken = 'a'.repeat(36);
const input = { ownerToken, title: 'Private writing', content: 'One private sentence.', voice: 'Adrian', sourceType: 'text' as const };
test('private snapshots require ownership and public projections never disclose the capability', async () => {
  const t = convexTest(schema, modules);
  const recordingId = await t.mutation(api.routers.listening.create, input);
  await expect(t.query(api.routers.listening.get, { recordingId })).rejects.toThrow('private');
  expect((await t.query(api.routers.listening.get, { recordingId, ownerToken })).canManage).toBe(true);
  await expect(t.mutation(api.routers.listening.setVisibility, { recordingId, visibility: 'link' })).rejects.toThrow('private');
  await t.mutation(api.routers.listening.setVisibility, { recordingId, ownerToken, visibility: 'link' });
  const shared = await t.query(api.routers.listening.get, { recordingId });
  expect(shared.content).toBe(input.content); expect(shared.canManage).toBe(false); expect(shared.ownerToken).toBeUndefined();
  await t.mutation(api.routers.listening.setVisibility, { recordingId, ownerToken, visibility: 'private' });
  expect(await t.query(internal.routers.listeningInternal.metadata, { recordingId })).toBeNull();
  await expect(t.query(api.routers.listening.get, { recordingId })).rejects.toThrow('private');
});
test('a repeated create joins the same record and record audio stays separate from the global digest', async () => {
  const t = convexTest(schema, modules);
  const recordingId = await t.mutation(api.routers.listening.create, input);
  expect(await t.mutation(api.routers.listening.create, input)).toBe(recordingId);
  const text = input.content;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const contentDigest = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  await t.action(api.routers.narration.prepare, { recordingId, ownerToken, text, voice: input.voice, clientId: 'test' });
  await t.action(api.routers.narration.prepare, { recordingId, ownerToken, text, voice: input.voice, clientId: 'test' });
  const jobs = await t.run(ctx => ctx.db.query('narrationJobs').collect()); expect(jobs).toHaveLength(1);
  expect(jobs[0]!.contentDigest).toBe(`${recordingId}:${contentDigest}`);
  expect((await t.query(api.routers.narration.page, { contentDigest, voice: input.voice, from: 0 })).status).toBe('none');
  await expect(t.query(api.routers.narration.page, { recordingId, contentDigest, voice: input.voice, from: 0 })).rejects.toThrow('private');
  await t.finishInProgressScheduledFunctions();
});
test('audio ranges support seeking without a permanent storage redirect', async () => {
  const blob = new Blob(['0123456789']);
  const response = listeningAudioResponse(blob, 'bytes=3-6');
  expect(response.status).toBe(206); expect(await response.text()).toBe('3456');
  expect(response.headers.get('Content-Range')).toBe('bytes 3-6/10');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(listeningAudioResponse(blob, 'bytes=20-').status).toBe(416);
  expect(await listeningAudioResponse(blob, 'bytes=-3').text()).toBe('789');
});

test('published listeners join one recording job and revocation denies section bytes', async () => {
  const t = convexTest(schema, modules);
  const recordingId = await t.mutation(api.routers.listening.create, input);
  await t.mutation(api.routers.listening.setVisibility, { recordingId, ownerToken, visibility: 'link' });
  const requests = Array.from({ length: 10 }, (_, i) => t.action(api.routers.narration.prepare, { recordingId, text: input.content, voice: input.voice, clientId: `visitor-${i}` }));
  await Promise.all(requests);
  const jobs = await t.run(ctx => ctx.db.query('narrationJobs').collect()); expect(jobs).toHaveLength(1);
  const section = (await t.run(ctx => ctx.db.query('narrationSections').first()))!;
  const storageId = await t.run(ctx => ctx.storage.store(new Blob(['audio'])));
  await t.run(ctx => ctx.db.patch(section._id, { storageId, status: 'done' }));
  expect(await t.query(internal.routers.listeningInternal.section, { recordingId, sectionId: section._id })).toBe(storageId);
  await t.mutation(api.routers.listening.setVisibility, { recordingId, ownerToken, visibility: 'private' });
  await expect(t.query(internal.routers.listeningInternal.section, { recordingId, sectionId: section._id })).rejects.toThrow('private');
  expect(await t.query(internal.routers.listeningInternal.section, { recordingId, ownerToken, sectionId: section._id })).toBe(storageId);
  await t.finishInProgressScheduledFunctions();
});
