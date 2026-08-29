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
  articles: {
    document: {
      author: string;
      authorAvatar?: string;
      authorHandle?: string;
      content: string;
      createdAt: number;
      image?: string;
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
  sessions: {
    document: {
      expiresAt: number;
      token: string;
      userId: Id<"users">;
      _id: Id<"sessions">;
      _creationTime: number;
    };
    fieldPaths: "_creationTime" | "_id" | "expiresAt" | "token" | "userId";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_token: ["token", "_creationTime"];
      by_user: ["userId", "_creationTime"];
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
      userId: Id<"users">;
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
  users: {
    document: {
      avatar?: string;
      createdAt: number;
      email: string;
      lastLoginAt: number;
      name: string;
      provider: "email" | "google" | "apple";
      tier: "free" | "pro";
      _id: Id<"users">;
      _creationTime: number;
    };
    fieldPaths:
      | "_creationTime"
      | "_id"
      | "avatar"
      | "createdAt"
      | "email"
      | "lastLoginAt"
      | "name"
      | "provider"
      | "tier";
    indexes: {
      by_id: ["_id"];
      by_creation_time: ["_creationTime"];
      by_email: ["email", "_creationTime"];
      by_tier: ["tier", "_creationTime"];
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
