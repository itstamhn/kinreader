import { test, expect } from 'bun:test';
import { convexTest } from 'convex-test';
import schema from '../schema';
import { api } from '../../shared/api';

const modules: Record<string, () => Promise<unknown>> = {
  './_generated/server.js': () => import('../_generated/server'),
  './routers/users.ts': () => import('./users'),
};

test('unauthenticated call to getUserPlaylist returns empty array', async () => {
  const t = convexTest(schema, modules);
  // Call query without auth identity
  const playlist = await t.query(api.routers.users.getUserPlaylist, {});
  expect(playlist).toEqual([]);
});

test('unauthenticated call to saveUserProgress throws Unauthorized', async () => {
  const t = convexTest(schema, modules);
  const articleId = await t.run(async (ctx) => {
    return await ctx.db.insert('articles', {
      url: 'https://example.com/test',
      title: 'Test Article',
      content: 'Sample content',
      author: 'Author',
      sourceType: 'article',
      wordCount: 100,
      createdAt: Date.now(),
    });
  });

  expect(async () => {
    await t.mutation(api.routers.users.saveUserProgress, {
      articleId,
      progress: 50,
      lastWordIndex: 10,
      currentTime: 15,
      isCompleted: false,
    });
  }).toThrow('Unauthorized');
});

test('authenticated user can save and retrieve their own progress', async () => {
  const t = convexTest(schema, modules);

  // 1. Create a user record
  const userId = await t.run(async (ctx) => {
    return await ctx.db.insert('user', {
      name: 'Alice',
      email: 'alice@example.com',
      emailVerified: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  // 2. Create an article
  const articleId = await t.run(async (ctx) => {
    return await ctx.db.insert('articles', {
      url: 'https://example.com/alice-article',
      title: 'Alice Article',
      content: 'Content for Alice',
      author: 'Alice Author',
      sourceType: 'article',
      wordCount: 120,
      createdAt: Date.now(),
    });
  });

  // 3. Act as Alice
  const alice = t.withIdentity({
    name: 'Alice',
    email: 'alice@example.com',
    tokenIdentifier: 'test|alice@example.com',
  });

  // Save progress as Alice
  await alice.mutation(api.routers.users.saveUserProgress, {
    articleId,
    progress: 75,
    lastWordIndex: 25,
    currentTime: 30,
    isCompleted: false,
  });

  // Get playlist as Alice
  const playlist = await alice.query(api.routers.users.getUserPlaylist, {});
  expect(playlist.length).toBe(1);
  expect(playlist[0]!.articleId).toBe(articleId);
  expect(playlist[0]!.progress).toBe(75);

  // Get current user profile
  const me = await alice.query(api.routers.users.getCurrentUser, {});
  expect(me?.email).toBe('alice@example.com');
  expect(me?.name).toBe('Alice');
});

test('cross-user isolation: Bob cannot view or modify Alice playlist', async () => {
  const t = convexTest(schema, modules);

  // Create Alice and Bob in user table
  const aliceId = await t.run(async (ctx) => {
    return await ctx.db.insert('user', {
      name: 'Alice',
      email: 'alice@example.com',
      emailVerified: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  const bobId = await t.run(async (ctx) => {
    return await ctx.db.insert('user', {
      name: 'Bob',
      email: 'bob@example.com',
      emailVerified: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  const articleId = await t.run(async (ctx) => {
    return await ctx.db.insert('articles', {
      url: 'https://example.com/shared',
      title: 'Shared Article',
      content: 'Article content',
      author: 'Author',
      sourceType: 'article',
      wordCount: 80,
      createdAt: Date.now(),
    });
  });

  // Alice saves progress
  const alice = t.withIdentity({
    name: 'Alice',
    email: 'alice@example.com',
    tokenIdentifier: 'test|alice@example.com',
  });

  await alice.mutation(api.routers.users.saveUserProgress, {
    articleId,
    progress: 90,
    lastWordIndex: 40,
    currentTime: 60,
    isCompleted: false,
  });

  // Bob checks his playlist
  const bob = t.withIdentity({
    name: 'Bob',
    email: 'bob@example.com',
    tokenIdentifier: 'test|bob@example.com',
  });

  const bobPlaylist = await bob.query(api.routers.users.getUserPlaylist, {});
  expect(bobPlaylist).toEqual([]); // Bob sees nothing

  // Bob saves his own progress on the same article
  await bob.mutation(api.routers.users.saveUserProgress, {
    articleId,
    progress: 10,
    lastWordIndex: 5,
    currentTime: 10,
    isCompleted: false,
  });

  // Alice checks her playlist -> Alice's progress remains untouched (90%)
  const alicePlaylist = await alice.query(api.routers.users.getUserPlaylist, {});
  expect(alicePlaylist.length).toBe(1);
  expect(alicePlaylist[0]!.progress).toBe(90);

  // Bob checks his playlist -> Bob's progress is 10%
  const bobPlaylistAfter = await bob.query(api.routers.users.getUserPlaylist, {});
  expect(bobPlaylistAfter.length).toBe(1);
  expect(bobPlaylistAfter[0]!.progress).toBe(10);
});
