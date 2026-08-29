
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`packages/backend/convex/functions/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Repo layout

A Bun workspace. Run commands from the directory that owns the config:

| Path | Package | What it is | Commands |
|------|---------|-----------|----------|
| `apps/web` | `@kinreader/web` | The Vite SPA and the Cloudflare Worker (auth, share routes) | `bun run dev`, `vite build`, `bunx wrangler deploy` |
| `apps/marketing` | `@kinreader/marketing` | The Astro site on the apex: landing, blog, `/r/:id`, `/api/og` | `bun run dev`, `astro build`, `bunx wrangler deploy` |
| `packages/backend` | `@kinreader/backend` | Convex functions — the functions root is `convex/functions`, and `convex/lib` and `convex/shared` are deliberately outside it. | `bunx convex dev`, `bunx kitcn codegen` |

From the repo root, `bun run typecheck`, `bun run test` and `bun run build` fan out to
every package via `bun run --filter`. **`bun test` at the root does not work** — the
happy-dom preload lives in `apps/web/bunfig.toml`, so run `bun run test` instead, or
`bun test` from inside a package.

The web app imports the backend as `@kinreader/backend/api`, never by relative path.

kitcn ships its own agent skill inside its npm package; it is vendored to
`.claude/skills/kitcn` (see `VENDORED.md` there to refresh it after a kitcn bump). Layout follows `convex.json` with functions under `convex/functions/`.

Two origins, deliberately: `kinreader.com` is the marketing site, `app.kinreader.com` is
the reader. They do not share cookies or `localStorage`, so anything that assumes
same-origin between them needs an explicit CORS or `targetOrigin` decision.

Astro routes **every** file under `apps/marketing/src/pages`, so tests for that package
live in `apps/marketing/test/`. Its `wrangler.jsonc` must not set `main` or `assets` —
the Cloudflare adapter generates those at build time.

Planned but not yet present: `apps/mobile` (Expo). See `plans/013` and `plans/014`.
