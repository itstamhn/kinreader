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

  listeningRecords: defineTable({
    ownerToken: v.string(), ownerId: v.optional(v.string()),
    title: v.string(), content: v.string(), author: v.optional(v.string()),
    sourceUrl: v.optional(v.string()), image: v.optional(v.string()),
    sourceType: v.optional(v.union(v.literal('article'), v.literal('x'), v.literal('text'))),
    voice: v.string(), visibility: v.union(v.literal('private'), v.literal('link')), createdAt: v.number(),
  }).index('by_owner_token', ['ownerToken']),

  // 6. Saved / Extracted Articles
  articles: defineTable({
    recordingId: v.optional(v.id('listeningRecords')),
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
    .index('by_article', ['articleId']),

  // Legacy pre-owner capabilities. Retain this table during staged rollout
  // so any deployed rows remain schema-compatible; no current function reads
  // or writes it.
  ttsUploadGrants: defineTable({
    token: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_token', ['token'])
    .index('by_expires_at', ['expiresAt']),

  // Owner-bound exact-track capabilities. This is intentionally a new table:
  // adding required ownership fields to the already-deployed legacy grant
  // table would make schema validation depend on whether an old grant exists.
  ttsExactUploadGrants: defineTable({
    token: v.string(),
    ownerKey: v.string(),
    cacheKey: v.string(),
    contentDigest: v.string(),
    voice: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_token', ['token'])
    .index('by_expires_at', ['expiresAt']),

  // Unique storage ownership for tracks created after this feature. Using a
  // new empty table avoids a blocking index backfill on populated audioTracks.
  ttsTrackStorageClaims: defineTable({
    storageId: v.id('_storage'),
    trackId: v.id('audioTracks'),
    kind: v.union(v.literal('exact'), v.literal('rest')),
    ownerKey: v.optional(v.string()),
    grantToken: v.optional(v.string()),
    claimedAt: v.number(),
  })
    .index('by_storage_id', ['storageId'])
    .index('by_track_id', ['trackId']),

  // Server-side pre-generation of exact tracks (tts.pregenerate). One row per
  // (content digest, voice) so concurrent requests for the same article do
  // not pay Soniox twice; a `running` row older than the staleness window is
  // treated as abandoned and may be claimed again.
  ttsPregenerationJobs: defineTable({
    contentDigest: v.string(),
    voice: v.string(),
    status: v.union(v.literal('running'), v.literal('done'), v.literal('failed')),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index('by_digest_voice', ['contentDigest', 'voice']),

  narrationJobs: defineTable({
    contentDigest: v.string(),
    voice: v.string(),
    status: v.union(v.literal('running'), v.literal('done'), v.literal('failed')),
    total: v.number(),
    completed: v.number(),
    createdAt: v.number(),
  }).index('by_contentDigest_and_voice', ['contentDigest', 'voice'])
    .index('by_status', ['status']),

  narrationSections: defineTable({
    jobId: v.id('narrationJobs'),
    index: v.number(),
    text: v.string(),
    status: v.union(v.literal('queued'), v.literal('running'), v.literal('done'), v.literal('failed')),
    attempt: v.number(),
    storageId: v.optional(v.id('_storage')),
    words: v.optional(v.array(v.object({ text: v.string(), start: v.number(), end: v.number() }))),
    duration: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index('by_jobId_and_index', ['jobId', 'index'])
    .index('by_jobId_and_status', ['jobId', 'status'])
    .index('by_status', ['status']),

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
