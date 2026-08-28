/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crpc from "../crpc.js";
import type * as generated_auth from "../generated/auth.js";
import type * as generated_server from "../generated/server.js";
import type * as lib_rateLimiter from "../lib/rateLimiter.js";
import type * as routers_articles from "../routers/articles.js";
import type * as routers_tts from "../routers/tts.js";
import type * as routers_ttsInternal from "../routers/ttsInternal.js";
import type * as routers_users from "../routers/users.js";
import type * as shared_api from "../shared/api.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crpc: typeof crpc;
  "generated/auth": typeof generated_auth;
  "generated/server": typeof generated_server;
  "lib/rateLimiter": typeof lib_rateLimiter;
  "routers/articles": typeof routers_articles;
  "routers/tts": typeof routers_tts;
  "routers/ttsInternal": typeof routers_ttsInternal;
  "routers/users": typeof routers_users;
  "shared/api": typeof shared_api;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
