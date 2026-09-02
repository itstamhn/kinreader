/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { GenericId as Id } from "convex/values";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: {
  routers: {
    articles: {
      extract: FunctionReference<
        "action",
        "public",
        { clientId?: string; url: string },
        any
      >;
    };
    tts: {
      pregenerationStatus: FunctionReference<
        "query",
        "public",
        { contentDigest: string; voice: string },
        "none" | "running" | "done" | "failed"
      >;
      pregenerate: FunctionReference<
        "action",
        "public",
        {
          author?: string;
          clientId?: string;
          text: string;
          title?: string;
          voice?: string;
        },
        any
      >;
      generateTrackUploadUrl: FunctionReference<
        "mutation",
        "public",
        { cacheKey: string; contentDigest: string; voice: string },
        { expiresAt: number; grant: string; uploadUrl: string }
      >;
      getExactTrack: FunctionReference<
        "query",
        "public",
        { url: string; voice: string },
        {
          audioUrl: string;
          duration: number;
          timingsSource: "soniox";
          words: Array<{ end: number; start: number; text: string }>;
        } | null
      >;
      persistTrack: FunctionReference<
        "mutation",
        "public",
        {
          author?: string;
          duration: number;
          grant: string;
          storageId: string;
          text: string;
          title?: string;
          url: string;
          voice: string;
          words: Array<{ end: number; start: number; text: string }>;
        },
        | { articleId: string; ok: true; trackId: string }
        | { error: string; ok: false }
      >;
      synthesize: FunctionReference<
        "action",
        "public",
        {
          author?: string;
          clientId?: string;
          groqApiKey?: string;
          sonioxApiKey?: string;
          speed?: number;
          text: string;
          title?: string;
          url: string;
          voice?: string;
        },
        any
      >;
      temporaryKey: FunctionReference<
        "action",
        "public",
        { clientId?: string },
        any
      >;
    };
    users: {
      addToPlaylist: FunctionReference<
        "mutation",
        "public",
        {
          author?: string;
          authorAvatar?: string;
          authorHandle?: string;
          content: string;
          image?: string;
          sourceType?: "article" | "x" | "text";
          title: string;
          url: string;
        },
        any
      >;
      deleteUserArticle: FunctionReference<
        "mutation",
        "public",
        { articleId: string },
        any
      >;
      getCurrentUser: FunctionReference<"query", "public", {}, any>;
      getUserPlaylist: FunctionReference<"query", "public", {}, any>;
      saveUserProgress: FunctionReference<
        "mutation",
        "public",
        {
          articleId: string;
          currentTime: number;
          isCompleted: boolean;
          lastWordIndex: number;
          progress: number;
        },
        any
      >;
    };
  };
};

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: {
  generated: {
    auth: {
      consumeOne: FunctionReference<
        "mutation",
        "internal",
        { input: { model: string; where?: Array<any> } },
        any
      >;
      count: FunctionReference<
        "query",
        "internal",
        {
          model: string;
          where?: Array<{
            connector?: "AND" | "OR";
            field: string;
            mode?: "sensitive" | "insensitive";
            operator?:
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "eq"
              | "in"
              | "not_in"
              | "ne"
              | "contains"
              | "starts_with"
              | "ends_with";
            value:
              string | number | boolean | Array<string> | Array<number> | null;
          }>;
        },
        any
      >;
      create: FunctionReference<
        "mutation",
        "internal",
        { input: { data: any; model: string }; select?: Array<string> },
        any
      >;
      deleteMany: FunctionReference<
        "mutation",
        "internal",
        {
          input: { model: string; where?: Array<any> };
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        any
      >;
      deleteOne: FunctionReference<
        "mutation",
        "internal",
        { input: { model: string; where?: Array<any> } },
        any
      >;
      findMany: FunctionReference<
        "query",
        "internal",
        {
          join?: any;
          limit?: number;
          model: string;
          offset?: number;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          sortBy?: { direction: "asc" | "desc"; field: string };
          where?: Array<{
            connector?: "AND" | "OR";
            field: string;
            mode?: "sensitive" | "insensitive";
            operator?:
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "eq"
              | "in"
              | "not_in"
              | "ne"
              | "contains"
              | "starts_with"
              | "ends_with";
            value:
              string | number | boolean | Array<string> | Array<number> | null;
          }>;
        },
        any
      >;
      findOne: FunctionReference<
        "query",
        "internal",
        {
          join?: any;
          model: string;
          select?: Array<string>;
          where?: Array<{
            connector?: "AND" | "OR";
            field: string;
            mode?: "sensitive" | "insensitive";
            operator?:
              | "lt"
              | "lte"
              | "gt"
              | "gte"
              | "eq"
              | "in"
              | "not_in"
              | "ne"
              | "contains"
              | "starts_with"
              | "ends_with";
            value:
              string | number | boolean | Array<string> | Array<number> | null;
          }>;
        },
        any
      >;
      getLatestJwks: FunctionReference<"action", "internal", {}, any>;
      incrementOne: FunctionReference<
        "mutation",
        "internal",
        {
          input: {
            increment: Record<string, number>;
            model: string;
            set?: Record<string, any>;
            where?: Array<{
              connector?: "AND" | "OR";
              field: string;
              mode?: "sensitive" | "insensitive";
              operator?:
                | "lt"
                | "lte"
                | "gt"
                | "gte"
                | "eq"
                | "in"
                | "not_in"
                | "ne"
                | "contains"
                | "starts_with"
                | "ends_with";
              value:
                | string
                | number
                | boolean
                | Array<string>
                | Array<number>
                | null;
            }>;
          };
        },
        any
      >;
      rotateKeys: FunctionReference<"action", "internal", {}, any>;
      updateMany: FunctionReference<
        "mutation",
        "internal",
        {
          input: { model: string; update: any; where?: Array<any> };
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        any
      >;
      updateOne: FunctionReference<
        "mutation",
        "internal",
        { input: { model: string; update: any; where?: Array<any> } },
        any
      >;
    };
  };
  routers: {
    articlesInternal: {
      consumeExtractRateLimit: FunctionReference<
        "mutation",
        "internal",
        { key: string },
        { ok: boolean }
      >;
    };
    digest: {
      getWeeklyDigestRecipients: FunctionReference<
        "mutation",
        "internal",
        {},
        any
      >;
      sendWeeklyDigests: FunctionReference<"action", "internal", {}, any>;
      unsubscribeDigest: FunctionReference<
        "mutation",
        "internal",
        { email: string },
        any
      >;
    };
    pregenerate: {
      generate: FunctionReference<
        "action",
        "internal",
        {
          author?: string;
          contentDigest: string;
          text: string;
          title?: string;
          voice: string;
        },
        "done" | "failed" | "skipped"
      >;
    };
    ttsInternal: {
      pregenerationJobStatus: FunctionReference<
        "query",
        "internal",
        { contentDigest: string; voice: string },
        "none" | "running" | "done" | "failed"
      >;
      claimPregenerationJob: FunctionReference<
        "mutation",
        "internal",
        { contentDigest: string; voice: string },
        "claimed" | "running" | "done"
      >;
      completePregenerationJob: FunctionReference<
        "mutation",
        "internal",
        {
          contentDigest: string;
          error?: string;
          status: "done" | "failed";
          voice: string;
        },
        null
      >;
      findGlobalExactTrack: FunctionReference<
        "query",
        "internal",
        { contentDigest: string; voice: string },
        any
      >;
      finalizeGlobalExactTrack: FunctionReference<
        "mutation",
        "internal",
        {
          author?: string;
          content: string;
          contentDigest: string;
          duration: number;
          storageId: Id<"_storage">;
          title?: string;
          voice: string;
          words: Array<{ end: number; start: number; text: string }>;
        },
        { articleId: Id<"articles">; trackId: Id<"audioTracks"> }
      >;
      cleanupAbandonedTrackUploads: FunctionReference<
        "mutation",
        "internal",
        { cursor: string | null; now?: number },
        { continueCursor: string | null; deleted: number; scanned: number }
      >;
      consumeTtsRateLimit: FunctionReference<
        "mutation",
        "internal",
        {
          key: string;
          purpose?: "synthesize" | "temporaryKey" | "trackUpload";
        },
        { ok: boolean }
      >;
      finalizeExactTrack: FunctionReference<
        "mutation",
        "internal",
        {
          author?: string;
          cacheKey: string;
          content: string;
          duration: number;
          grant: string;
          ownerKey: string;
          storageId: Id<"_storage">;
          title?: string;
          voice: string;
          words: Array<{ end: number; start: number; text: string }>;
        },
        { articleId: Id<"articles">; trackId: Id<"audioTracks"> }
      >;
      findCachedTrackByUrl: FunctionReference<
        "query",
        "internal",
        { speed: number; url: string; voice: string },
        null | {
          _creationTime: number;
          _id: Id<"audioTracks">;
          articleId: Id<"articles">;
          audioBase64?: string;
          createdAt: number;
          duration: number;
          speed: number;
          storageId?: Id<"_storage">;
          timingsSource?: "soniox" | "estimated";
          voice: string;
          words: Array<{ end: number; start: number; text: string }>;
        }
      >;
      findExactCachedTrackByUrl: FunctionReference<
        "query",
        "internal",
        { cacheKey: string; ownerKey: string; voice: string },
        null | {
          _creationTime: number;
          _id: Id<"audioTracks">;
          articleId: Id<"articles">;
          audioBase64?: string;
          createdAt: number;
          duration: number;
          speed: number;
          storageId?: Id<"_storage">;
          timingsSource?: "soniox" | "estimated";
          voice: string;
          words: Array<{ end: number; start: number; text: string }>;
        }
      >;
      getOrCreateArticleStub: FunctionReference<
        "mutation",
        "internal",
        {
          author?: string;
          content: string;
          sourceType?: "article" | "x" | "text";
          title?: string;
          url: string;
        },
        Id<"articles">
      >;
      insertAudioTrack: FunctionReference<
        "mutation",
        "internal",
        {
          articleId: Id<"articles">;
          duration: number;
          speed: number;
          storageId: Id<"_storage">;
          timingsSource?: "soniox" | "estimated";
          voice: string;
          words: Array<{ end: number; start: number; text: string }>;
        },
        Id<"audioTracks">
      >;
      issueTrackUploadGrant: FunctionReference<
        "mutation",
        "internal",
        {
          cacheKey: string;
          contentDigest: string;
          expiresAt: number;
          ownerKey: string;
          token: string;
          voice: string;
        },
        { ok: false } | { expiresAt: number; grant: string; ok: true }
      >;
      rejectExactTrackUpload: FunctionReference<
        "mutation",
        "internal",
        {
          cacheKey: string;
          content: string;
          grant: string;
          ownerKey: string;
          storageId: Id<"_storage">;
          voice: string;
        },
        { deleted: boolean }
      >;
    };
    users: {
      markEmailBounced: FunctionReference<
        "mutation",
        "internal",
        { email: string },
        any
      >;
      markEmailComplained: FunctionReference<
        "mutation",
        "internal",
        { email: string },
        any
      >;
      recordWelcomeEmailSent: FunctionReference<
        "mutation",
        "internal",
        { email: string },
        any
      >;
      sendWelcomeEmailIfNew: FunctionReference<
        "action",
        "internal",
        { email: string; name?: string },
        any
      >;
    };
  };
};

export declare const components: {};
