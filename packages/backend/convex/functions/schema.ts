import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // 1. Better Auth: User Table
  user: defineTable({
    name: v.string(),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    role: v.optional(v.string()),
    banned: v.optional(v.boolean()),
    banReason: v.optional(v.string()),
    banExpires: v.optional(v.number()),
    tier: v.optional(v.union(v.literal('free'), v.literal('pro'))),
    welcomeEmailSentAt: v.optional(v.number()),
    emailBounced: v.optional(v.boolean()),
    emailComplained: v.optional(v.boolean()),
    digestOptOut: v.optional(v.boolean()),
  }).index('email', ['email']),

  // 2. Better Auth: Session Table
  session: defineTable({
    token: v.string(),
    userId: v.id('user'),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    impersonatedBy: v.optional(v.string()),
  })
    .index('token', ['token'])
    .index('userId', ['userId']),

  // 3. Better Auth: Account Table
  account: defineTable({
    accountId: v.string(),
    providerId: v.string(),
    userId: v.id('user'),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    idToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    refreshTokenExpiresAt: v.optional(v.number()),
    scope: v.optional(v.string()),
    password: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('accountId', ['accountId'])
    .index('userId', ['userId']),

  // 4. Better Auth: Verification Table
  verification: defineTable({
    identifier: v.string(),
    value: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('identifier', ['identifier']),

  // 5. Better Auth: JWKS Table
  jwks: defineTable({
    publicKey: v.string(),
    privateKey: v.string(),
    createdAt: v.number(),
    alg: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
  }),

  // 6. Saved / Extracted Articles
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

  // 7. Cached Audio Tracks (Persistent Audio + Exact Whisper Timestamps)
  audioTracks: defineTable({
    articleId: v.id('articles'),
    voice: v.string(), // e.g. 'Adrian', 'Emma'
    speed: v.number(), // e.g. 1.0
    storageId: v.optional(v.id('_storage')), // Convex File Storage ID
    audioBase64: v.optional(v.string()), // Inline fallback base64
    duration: v.number(),
    timingsSource: v.optional(v.union(v.literal('soniox'), v.literal('estimated'))),
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
    .index('by_article', ['articleId'])
    .index('by_storage_id', ['storageId']),

  // Short-lived capabilities issued alongside browser upload URLs. A grant
  // is consumed in the same transaction that creates its exact-track row,
  // binding each successful finalization to one rate-limited issuance.
  ttsUploadGrants: defineTable({
    token: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_token', ['token'])
    .index('by_expires_at', ['expiresAt']),

  // 8. User Reading Playlists & Cross-Device Progress
  userArticles: defineTable({
    userId: v.id('user'),
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

  // 9. Rate limiter state
  ratelimitState: defineTable({
    name: v.string(),
    key: v.optional(v.string()),
    shard: v.number(),
    value: v.number(),
    ts: v.number(),
    auxValue: v.optional(v.number()),
    auxTs: v.optional(v.number()),
  })
    .index('by_name_key_shard', ['name', 'key', 'shard'])
    .index('by_name_key', ['name', 'key'])
    .index('by_ts', ['ts']),
});
