import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // 1. User Profiles & Accounts
  users: defineTable({
    email: v.string(),
    name: v.string(),
    avatar: v.optional(v.string()),
    tier: v.union(v.literal('free'), v.literal('pro')),
    provider: v.union(v.literal('email'), v.literal('google'), v.literal('apple')),
    createdAt: v.number(),
    lastLoginAt: v.number(),
  })
    .index('by_email', ['email'])
    .index('by_tier', ['tier']),

  // 2. Saved / Extracted Articles
  articles: defineTable({
    url: v.string(),
    title: v.string(),
    content: v.string(),
    author: v.string(),
    authorHandle: v.optional(v.string()),
    authorAvatar: v.optional(v.string()),
    image: v.optional(v.string()),
    sourceType: v.union(v.literal('article'), v.literal('x'), v.literal('text')),
    wordCount: v.number(),
    createdAt: v.number(),
  })
    .index('by_url', ['url'])
    .index('by_created', ['createdAt']),

  // 3. Cached Audio Tracks (Persistent Audio + Exact Whisper Timestamps)
  audioTracks: defineTable({
    articleId: v.id('articles'),
    voice: v.string(), // e.g. 'Adrian', 'Daniel'
    speed: v.number(), // e.g. 1.0
    storageId: v.optional(v.id('_storage')), // Convex File Storage ID
    audioBase64: v.optional(v.string()), // Inline fallback base64
    duration: v.number(),
    words: v.array(
      v.object({
        text: v.string(),
        start: v.number(),
        end: v.number(),
      })
    ),
    createdAt: v.number(),
  })
    .index('by_article_voice_speed', ['articleId', 'voice', 'speed'])
    .index('by_article', ['articleId']),

  // 4. User Reading Playlists & Cross-Device Progress
  userArticles: defineTable({
    userId: v.id('users'),
    articleId: v.id('articles'),
    progress: v.number(), // 0 to 100
    lastWordIndex: v.number(),
    currentTime: v.number(),
    isCompleted: v.boolean(),
    updatedAt: v.number(),
  })
    .index('by_user_article', ['userId', 'articleId'])
    .index('by_user', ['userId'])
    .index('by_updated', ['updatedAt']),

  // 5. Auth Sessions & Tokens
  sessions: defineTable({
    userId: v.id('users'),
    token: v.string(),
    expiresAt: v.number(),
  })
    .index('by_token', ['token'])
    .index('by_user', ['userId']),
});
