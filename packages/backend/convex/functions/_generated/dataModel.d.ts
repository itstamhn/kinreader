/* eslint-disable */
/**
 * Generated data model types.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
  AnyDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";

/**
 * A type describing your Convex data model.
 *
 * This type includes information about what tables you have, the type of
 * documents stored in those tables, and the indexes defined on them.
 *
 * This type is used to parameterize methods like `queryGeneric` and
 * `mutationGeneric` to make them type-safe.
 */

export type DataModel = {
  account: {
    document: {
      accessToken?: string;
      accessTokenExpiresAt?: number;
      accountId: string;
      createdAt: number;
      idToken?: string;
      password?: string;
      providerId: string;
      refreshToken?: string;
      refreshTokenExpiresAt?: number;
      scope?: string;
      updatedAt: number;
      userId: Id<"user">;
      _id: Id<"account">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "accessToken"
      | "accessTokenExpiresAt"
      | "accountId"
      | "createdAt"
      | "idToken"
      | "password"
      | "providerId"
      | "refreshToken"
      | "refreshTokenExpiresAt"
      | "scope"
      | "updatedAt"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      accountId: ["accountId", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  articles: {
    document: {
      author: string;
      authorAvatar?: string;
      authorHandle?: string;
      content: string;
      createdAt: number;
      image?: string;
      recordingId?: Id<"listeningRecords">;
      sourceType: "article" | "x" | "text";
      title: string;
      url: string;
      wordCount: number;
      _id: Id<"articles">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "author"
      | "authorAvatar"
      | "authorHandle"
      | "content"
      | "createdAt"
      | "image"
      | "recordingId"
      | "sourceType"
      | "title"
      | "url"
      | "wordCount";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_created: ["createdAt", "_creationTime"];
      by_url: ["url", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  audioTracks: {
    document: {
      articleId: Id<"articles">;
      audioBase64?: string;
      createdAt: number;
      duration: number;
      speed: number;
      storageId?: Id<"_storage">;
      timingsSource?: "soniox" | "estimated";
      voice: string;
      words: Array<{ end: number; start: number; text: string }>;
      _id: Id<"audioTracks">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "articleId"
      | "audioBase64"
      | "createdAt"
      | "duration"
      | "speed"
      | "storageId"
      | "timingsSource"
      | "voice"
      | "words";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_article: ["articleId", "_creationTime"];
      by_article_voice_speed: ["articleId", "voice", "speed", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  jwks: {
    document: {
      alg?: string;
      createdAt: number;
      privateKey: string;
      publicKey: string;
      updatedAt?: number;
      _id: Id<"jwks">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "alg"
      | "createdAt"
      | "privateKey"
      | "publicKey"
      | "updatedAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  listeningRecords: {
    document: {
      author?: string;
      content: string;
      createdAt: number;
      image?: string;
      ownerId?: string;
      ownerToken: string;
      sourceType?: "article" | "x" | "text";
      sourceUrl?: string;
      title: string;
      visibility: "private" | "link";
      voice: string;
      _id: Id<"listeningRecords">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "author"
      | "content"
      | "createdAt"
      | "image"
      | "ownerId"
      | "ownerToken"
      | "sourceType"
      | "sourceUrl"
      | "title"
      | "visibility"
      | "voice";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_owner_token: ["ownerToken", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  narrationJobs: {
    document: {
      completed: number;
      contentDigest: string;
      createdAt: number;
      status: "running" | "done" | "failed";
      total: number;
      voice: string;
      _id: Id<"narrationJobs">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "completed"
      | "contentDigest"
      | "createdAt"
      | "status"
      | "total"
      | "voice";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_contentDigest_and_voice: ["contentDigest", "voice", "_creationTime"];
      by_status: ["status", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  narrationSections: {
    document: {
      attempt: number;
      duration?: number;
      error?: string;
      index: number;
      jobId: Id<"narrationJobs">;
      status: "queued" | "running" | "done" | "failed";
      storageId?: Id<"_storage">;
      text: string;
      words?: Array<{ end: number; start: number; text: string }>;
      _id: Id<"narrationSections">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "attempt"
      | "duration"
      | "error"
      | "index"
      | "jobId"
      | "status"
      | "storageId"
      | "text"
      | "words";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_jobId_and_index: ["jobId", "index", "_creationTime"];
      by_jobId_and_status: ["jobId", "status", "_creationTime"];
      by_status: ["status", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  ratelimitState: {
    document: {
      auxTs?: number;
      auxValue?: number;
      key?: string;
      name: string;
      shard: number;
      ts: number;
      value: number;
      _id: Id<"ratelimitState">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "auxTs"
      | "auxValue"
      | "key"
      | "name"
      | "shard"
      | "ts"
      | "value";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_name_key: ["name", "key", "_creationTime"];
      by_name_key_shard: ["name", "key", "shard", "_creationTime"];
      by_ts: ["ts", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  session: {
    document: {
      createdAt: number;
      expiresAt: number;
      impersonatedBy?: string;
      ipAddress?: string;
      token: string;
      updatedAt: number;
      userAgent?: string;
      userId: Id<"user">;
      _id: Id<"session">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "expiresAt"
      | "impersonatedBy"
      | "ipAddress"
      | "token"
      | "updatedAt"
      | "userAgent"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      token: ["token", "_creationTime"];
      userId: ["userId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  ttsExactUploadGrants: {
    document: {
      cacheKey: string;
      contentDigest: string;
      createdAt: number;
      expiresAt: number;
      ownerKey: string;
      token: string;
      voice: string;
      _id: Id<"ttsExactUploadGrants">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "cacheKey"
      | "contentDigest"
      | "createdAt"
      | "expiresAt"
      | "ownerKey"
      | "token"
      | "voice";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_expires_at: ["expiresAt", "_creationTime"];
      by_token: ["token", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  ttsPregenerationJobs: {
    document: {
      contentDigest: string;
      error?: string;
      finishedAt?: number;
      startedAt: number;
      status: "running" | "done" | "failed";
      voice: string;
      _id: Id<"ttsPregenerationJobs">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "contentDigest"
      | "error"
      | "finishedAt"
      | "startedAt"
      | "status"
      | "voice";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_digest_voice: ["contentDigest", "voice", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  ttsTrackStorageClaims: {
    document: {
      claimedAt: number;
      grantToken?: string;
      kind: "exact" | "rest";
      ownerKey?: string;
      storageId: Id<"_storage">;
      trackId: Id<"audioTracks">;
      _id: Id<"ttsTrackStorageClaims">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "claimedAt"
      | "grantToken"
      | "kind"
      | "ownerKey"
      | "storageId"
      | "trackId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_storage_id: ["storageId", "_creationTime"];
      by_track_id: ["trackId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  ttsUploadGrants: {
    document: {
      createdAt: number;
      expiresAt: number;
      token: string;
      _id: Id<"ttsUploadGrants">;
      _creationTime: number;
    };
    fieldPaths: "_creationTime" | "_id" | "createdAt" | "expiresAt" | "token";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_expires_at: ["expiresAt", "_creationTime"];
      by_token: ["token", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  user: {
    document: {
      banExpires?: number;
      banReason?: string;
      banned?: boolean;
      createdAt: number;
      digestOptOut?: boolean;
      email: string;
      emailBounced?: boolean;
      emailComplained?: boolean;
      emailVerified: boolean;
      image?: string;
      name: string;
      role?: string;
      tier?: "free" | "pro";
      updatedAt: number;
      welcomeEmailSentAt?: number;
      _id: Id<"user">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "banExpires"
      | "banned"
      | "banReason"
      | "createdAt"
      | "digestOptOut"
      | "email"
      | "emailBounced"
      | "emailComplained"
      | "emailVerified"
      | "image"
      | "name"
      | "role"
      | "tier"
      | "updatedAt"
      | "welcomeEmailSentAt";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      email: ["email", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  userArticles: {
    document: {
      articleId: Id<"articles">;
      currentTime: number;
      isCompleted: boolean;
      lastWordIndex: number;
      progress: number;
      updatedAt: number;
      userId: Id<"user">;
      _id: Id<"userArticles">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "articleId"
      | "currentTime"
      | "isCompleted"
      | "lastWordIndex"
      | "progress"
      | "updatedAt"
      | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_updated: ["updatedAt", "_creationTime"];
      by_user: ["userId", "_creationTime"];
      by_user_article: ["userId", "articleId", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
  verification: {
    document: {
      createdAt: number;
      expiresAt: number;
      identifier: string;
      updatedAt: number;
      value: string;
      _id: Id<"verification">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "createdAt"
      | "expiresAt"
      | "identifier"
      | "updatedAt"
      | "value";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      identifier: ["identifier", "_creationTime"];
    };
    searchIndexes: {};
    vectorIndexes: {};
  };
};

/**
 * The names of all of your Convex tables.
 */
export type TableNames = TableNamesInDataModel<DataModel>;

/**
 * The type of a document stored in Convex.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Doc<TableName extends TableNames> = DocumentByName<
  DataModel,
  TableName
>;

/**
 * An identifier for a document in Convex.
 *
 * Convex documents are uniquely identified by their `Id`, which is accessible
 * on the `_id` field. To learn more, see [Document IDs](https://docs.convex.dev/using/document-ids).
 *
 * Documents can be loaded using `db.get(tableName, id)` in query and mutation functions.
 *
 * IDs are just strings at runtime, but this type can be used to distinguish them from other
 * strings when type checking.
 *
 * @typeParam TableName - A string literal type of the table name (like "users").
 */
export type Id<TableName extends TableNames | SystemTableNames> =
  GenericId<TableName>;
