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
      extract: FunctionReference<"action", "public", { url: string }, any>;
    };
    tts: {
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
  routers: {
    ttsInternal: {
      consumeTtsRateLimit: FunctionReference<
        "mutation",
        "internal",
        { key: string },
        { ok: boolean }
      >;
      findCachedTrackByUrl: FunctionReference<
        "query",
        "internal",
        { speed: number; url: string; voice: string },
        any
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
        any
      >;
      insertAudioTrack: FunctionReference<
        "mutation",
        "internal",
        {
          articleId: Id<"articles">;
          duration: number;
          speed: number;
          storageId: Id<"_storage">;
          voice: string;
          words: Array<{ end: number; start: number; text: string }>;
        },
        any
      >;
    };
    users: {
      getUserPlaylist: FunctionReference<
        "query",
        "internal",
        { userId: Id<"users"> },
        any
      >;
      saveUserProgress: FunctionReference<
        "mutation",
        "internal",
        {
          articleId: Id<"articles">;
          currentTime: number;
          isCompleted: boolean;
          lastWordIndex: number;
          progress: number;
          userId: Id<"users">;
        },
        any
      >;
      upsertUser: FunctionReference<
        "mutation",
        "internal",
        {
          avatar?: string;
          email: string;
          name: string;
          provider: "email" | "google" | "apple";
        },
        any
      >;
    };
  };
};

export declare const components: {};
