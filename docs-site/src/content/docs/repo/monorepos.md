---
title: Monorepos
description: Where to place the config, workspace dependencies, and unbuilt-dist source aliases.
---

Designbook is built to work inside monorepos. A few things are worth knowing.

## Config placement & the project root

Put `.designbook/config.tsx` in the **package that depends on your components** — usually an
app package (e.g. `apps/web/.designbook/`), not the repo root. Globs in it are relative to
`.designbook/`, so reach a workspace lib with `../../../packages/ui/src/*.tsx` (up to the app,
up to the workspace root, into the lib). Import the lib's source; the app's own bundler
resolves the workspace alias. From there:

- The **project root** the agent edits defaults to the git root discovered above the config
  file. Override with `--root` / `DESIGNBOOK_CWD` if needed.
- The **target dev command** (`--target-cmd`) is spawned in the nearest `package.json` at/above
  the config — i.e. the app package, where the `dev`/`design` scripts live, not the git root.
  Override the spawn directory with `--target-cwd`, or the command with
  `--target-cmd "pnpm --filter <pkg> run dev:designbook"`.
- Auto-detection looks for a repo `vite.config` in the config's directory first, then the
  project root, then a one-level scan of `apps/*` / `packages/*`. If that scan turns up more
  than one candidate it disambiguates conservatively (see
  [Vite compatibility](/repo/compat/#whats-auto-detected)) — add a
  [sidecar](/repo/compat/#the-designbookvite-sidecar) to pin the right one.

## Workspace dependencies

Install `designbook` in the app package that actually runs it. For
[branch instances](/branch-instances/), Designbook resolves the `designbook` bin by walking up
from the config file's directory — so in a monorepo the bin next to your app package is found
correctly, not just one at the repo root.

Each workspace package's own `tsconfig` `paths` are honored per-importer via
`vite-tsconfig-paths`, so `@/` resolving differently in different packages just works.

## Unbuilt-`dist` source aliases

A common monorepo situation: a workspace dependency's `package.json` `exports` / `main` points
at a built `dist/` that isn't built during development. Designbook handles this — for a direct
workspace dependency of your config's package, if the entry points at an unbuilt `dist/` but a
`src/` exists, Designbook **synthesizes source aliases** so imports resolve to the package's
`src/` instead. That means you don't have to pre-build internal packages just to see them
render.

Sass `preprocessorOptions` / CSS-modules config from those workspace deps is also merged in
(closest-to-config wins), so shared Sass setup carries over.
