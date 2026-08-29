import { test, expect } from 'bun:test';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { calculateTimeSaved } from './digest';

test('calculateTimeSaved computes minutes saved at 450 WPM vs 200 WPM', () => {
  expect(calculateTimeSaved(0)).toBe(0);
  // 1000 words: 1000/200 = 5 min, 1000/450 = 2.22 min -> ~3 min saved
  expect(calculateTimeSaved(1000)).toBe(3);
  // 5000 words: 5000/200 = 25 min, 5000/450 = 11.1 min -> ~14 min saved
  expect(calculateTimeSaved(5000)).toBe(14);
});

test('unsubscribeDigest marks user as opted out', async () => {
  const modules: Record<string, () => Promise<unknown>> = {
    './_generated/server.js': () => import('../_generated/server'),
    './routers/digest.ts': () => import('./digest'),
    './routers/users.ts': () => import('./users'),
  };

  const t = convexTest(schema, modules);

  await t.run(async (ctx) => {
    await ctx.db.insert('user', {
      email: 'reader@example.com',
      name: 'Reader One',
      emailVerified: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  const { unsubscribeDigest } = await import('./digest');
  const res = await t.run(async (ctx) => {
    return await (unsubscribeDigest as any)._handler(ctx, { email: 'reader@example.com' });
  });
  expect(res.success).toBe(true);

  await t.run(async (ctx) => {
    const user = await ctx.db
      .query('user')
      .withIndex('email', (q) => q.eq('email', 'reader@example.com'))
      .first();
    expect(user?.digestOptOut).toBe(true);
  });
});

test('markEmailBounced sets emailBounced flag on user', async () => {
  const modules: Record<string, () => Promise<unknown>> = {
    './_generated/server.js': () => import('../_generated/server'),
    './routers/users.ts': () => import('./users'),
  };

  const t = convexTest(schema, modules);

  await t.run(async (ctx) => {
    await ctx.db.insert('user', {
      email: 'bounced@example.com',
      name: 'Bounced User',
      emailVerified: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  const { markEmailBounced } = await import('./users');
  await t.run(async (ctx) => {
    await (markEmailBounced as any)._handler(ctx, { email: 'bounced@example.com' });
  });

  await t.run(async (ctx) => {
    const user = await ctx.db
      .query('user')
      .withIndex('email', (q) => q.eq('email', 'bounced@example.com'))
      .first();
    expect(user?.emailBounced).toBe(true);
  });
});
