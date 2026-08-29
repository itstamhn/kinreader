# Plan 017: `apps/mobile` — the Expo app, and the shared core it forces out

> **Executor instructions**: Follow step by step. Run every verification command and
> confirm the expected result before moving on. If a STOP condition occurs, stop and
> report — do not improvise. **Step 0 is a go/no-go gate; do not skip it.**
>
> **Drift check (run first)**: `git diff --stat f5e5210..HEAD -- package.json apps packages`

## Status

- **Priority**: P3
- **Effort**: XL
- **Risk**: HIGH (a new platform, a new runtime, and the first real test of the workspace)
- **Depends on**: `plans/015` (kitcn's layout — `kitcn init` assumes it),
  `plans/008` (auth — see "Why 008 first")
- **Category**: feature / platform
- **Planned at**: commit `f5e5210`, 2026-08-29

## Why this matters

The whole monorepo exists for this. Plan 013 split the repo so a second client could share
one backend; `packages/backend` is that backend, and nothing has ever exercised the claim.

kitcn has an official path — `references/setup/expo.md` in the vendored skill
(`.claude/skills/kitcn`) documents `kitcn init -t expo`, and `kitcn init` takes
`--cwd apps --name mobile`. **Read that file before writing anything.** Hand-rolling an Expo
app beside a kitcn backend is how the two drift.

## Why 008 comes first

Mobile cannot use the auth that exists. The Google flow is a 302 dance that sets an
HttpOnly cookie and hands a token back **in the URL**, which `App.tsx` reads on mount.
React Native has no address bar to read it from and no cookie jar you would want to depend
on. Plan 008 moves auth to Convex/Better Auth, after which the mobile app gets sessions and
Google sign-in through `expo-auth-session` and a deep link.

Building the app first means either a second auth implementation or an app that cannot log
in. Neither is worth the sequencing saved.

## Step 0: The gate — does Metro resolve the workspace?

**Do this before anything else, and stop if it fails.**

Metro has historically been happiest with npm/pnpm, and workspace symlinks are exactly what
it has trouble resolving. This repo is Bun-first by policy (`CLAUDE.md`), and Bun links
workspace packages into the *consuming* package's `node_modules` (recorded in plan 013's
log). That combination is unproven here.

```bash
cd apps && bunx create-expo-app@latest __metro-probe --template blank-typescript
cd __metro-probe
# add "@kinreader/backend": "workspace:*", then, from the repo root:
bun install
# import the API surface in App.tsx and render one value from it
bunx expo start
```

If Metro resolves `@kinreader/backend/api` through the symlink, delete the probe and
continue. If it does not, **stop and report** with the exact resolution error. The options
at that point — `nohoist`-style config, a Metro `watchFolders` + `extraNodeModules` map, or
npm for this one package — are a decision about the repo's toolchain, not something to pick
mid-plan.

**Verify**: the probe renders a value that came from `packages/backend`, or the plan stops.

## Scope

**In scope**: `apps/mobile` via `kitcn init -t expo`, `packages/core` extracted from real
duplication, the reader screen, and auth wired to Better Auth.

**Out of scope**:

- Any change to `apps/web`'s behaviour. Extracting shared code must not alter what the web
  app does; if a web test changes, something went wrong.
- App Store / Play Store submission, EAS build config, push notifications.
- Offline sync. The web app's library is `localStorage`; making that a synced cross-device
  store is a backend design, not a mobile one.
- A shared component library. See "Maintenance notes" — this is the trap.

## Steps

### Step 1: Scaffold

```bash
bunx kitcn@latest init -t expo --cwd apps --name mobile
```

Follow `references/setup/expo.md` for what that path owns. Name the package
`@kinreader/mobile`, and point it at the existing backend rather than letting the template
scaffold a second `convex/` directory — **if it creates one, delete it and wire the import
to `@kinreader/backend/api`.** Two Convex directories in one repo is the failure this whole
sequence was meant to prevent.

**Verify**: `bun run typecheck` covers four packages. The app boots in a simulator and
renders a value fetched from the shared backend.

### Step 2: Extract `packages/core` — from duplication, not in anticipation

Only now, with two real callers. The shareable surface is thinner than it looks:

| Move to `packages/core` | Why |
|---|---|
| `types.ts` | `ArticleData`, `WordTiming`, `ReaderSettings` — pure types, zero platform |
| the word-at-time-`t` lookup | pure arithmetic over `WordTiming[]`, and the heart of the reader |
| article/duration formatting | small, pure, and already duplicated in both UIs by this point |

| Do **not** move | Why |
|---|---|
| `SpeechEngine` | builds an `HTMLAudioElement` and grabs `window.speechSynthesis` in its constructor |
| `storage.ts` | `localStorage`; mobile needs AsyncStorage |
| any component | Tailwind-on-DOM vs React Native primitives |

For the two platform ones, share the **interface** and inject the implementation: `core`
declares what a player and a store must do, `apps/web` supplies the Web Speech / localStorage
version, `apps/mobile` supplies `expo-av` + `expo-speech` / AsyncStorage.

**Verify**: `apps/web`'s test count is unchanged and every test still passes. That is the
real check — extraction that changes web behaviour has gone wrong.

### Step 3: The reader screen

The 60fps kinetic display is the interesting part and does **not** port. The web version
drives a `requestAnimationFrame` loop over DOM nodes; React Native wants Reanimated driving
values on the UI thread. Rebuild the renderer against the shared timing function — the
word-at-time-`t` lookup from Step 2 is the contract between them.

Start with the sample article and no audio, prove the typography animates at 60fps on a
real device, and only then wire playback. A janky reader is the one thing this app cannot
ship with; find out early, on hardware, not in a simulator.

**Verify**: the sample article animates smoothly on a physical device.

### Step 4: Auth

Better Auth (plan 008) with `expo-auth-session` and a deep link back into the app. The
redirect URI is a **scheme**, not a URL — it needs registering in the Google console
alongside the two web ones, and it is a different client type (iOS/Android, not Web).

**Verify**: sign in on a real device; the session survives a cold start; sign out clears it.

### Step 5: Playback and the library

`expo-av` for audio, `expo-speech` for the on-device voice, both behind the Step 2
interface. The library uses AsyncStorage through the same shared interface.

**Verify**: an article plays with word highlighting synchronized within a frame or two, and
the library survives a restart.

## Test plan

- `packages/core` gets real unit tests for the timing lookup — boundaries, an empty array,
  a `t` past the end. It is shared by two clients now, so a bug is two bugs.
- `apps/web`'s suite must pass **unchanged** after Step 2.
- Mobile tests cover the platform adapters against the shared interface. Do not chase
  coverage of the RN view layer; the valuable assertions are in `core` and the adapters.

## Done criteria

- [ ] Step 0 passed, or the plan stopped there
- [ ] `apps/mobile` boots and reads live data from `packages/backend`
- [ ] `packages/core` holds only platform-free code; nothing imports `window` or `document`
- [ ] `apps/web` behaviour and test count unchanged
- [ ] Google sign-in works on a physical device and survives a cold start
- [ ] An article plays with synchronized kinetic typography on a physical device
- [ ] `bun run typecheck`, `bun run test`, `bun run build` clean across four packages

## STOP conditions

- **Step 0 fails.** The toolchain decision goes to the owner.
- `kitcn init -t expo` scaffolds a second `convex/` directory and it cannot be pointed at
  `@kinreader/backend`.
- Extracting `packages/core` changes any `apps/web` test.
- The kinetic display cannot hold 60fps on a real device. That is a product question — a
  slower, simpler mobile presentation may be the right answer — and not one to solve by
  quietly shipping something janky.
- Auth needs a second implementation because 008 has not landed. Go do 008.

## Maintenance notes

- **The trap is `packages/ui`.** Web is Tailwind-on-DOM; React Native has neither. A
  component package shared between them is the standard way these repos rot. Share types
  and pure functions; let each app own its rendering. This is written down in plan 013 too,
  because it is the thing most likely to be "fixed" later by someone being helpful.
- The vendored kitcn skill is pinned to 0.32.1 by hand. Re-read
  `references/setup/expo.md` after any kitcn bump — that path is what this plan follows.
- Three clients now share one backend, so a Convex procedure's contract is a public API.
  Changing an output shape is a coordinated release, not a refactor.
