---
title: Vite compatibility
description: How Designbook adapts to your build — zero-config auto-detection, the sidecar escape hatch, and plugin inheritance.
---

:::note[This page is about host mode]
In [injected mode](/getting-started/injected-mode/) your components compile through your app's
**own** Vite, so its aliases, tsconfig paths, and plugins already apply — no bridging needed. The
auto-detection and sidecar below only apply to [host mode](/getting-started/install-and-run/#host-mode-no-runnable-app),
where Designbook runs its own embedded Vite.
:::

In host mode Designbook runs its **own embedded Vite** (with `configFile: false`) to compile the
workbench UI, so it does not adopt your repo's build config wholesale. Instead it **bridges in** the
parts your components need to resolve and compile. The goal is zero-config: point it at your
repo and your components render.

## Precedence

The bridge sources are merged in this order (highest wins):

1. **Designbook's reserved aliases** — `@designbook-ui`, `@designbookapp/designbook/config`,
   `@designbookapp/designbook/adapters`. Always win.
2. **Explicit sidecar** — a `designbook.vite.{ts,mts,js,mjs}` next to your `designbook.config.*`.
   The full escape hatch.
3. **Auto-detected repo `vite.config.*`** — zero-config; a **safe allowlist** of fields is
   merged.
4. **`tsconfig` paths** — each workspace package's own `compilerOptions.paths`, honored
   per-importer via `vite-tsconfig-paths`.
5. **Next.js shims** — inert stubs for `next/*` when your repo depends on `next`. Lowest
   precedence.

## What's auto-detected

Designbook searches for a repo `vite.config.{ts,mts,js,mjs}` — first in your config's
directory, then the project root, then a one-level scan of `apps/*`, `packages/*`, and other
workspace members. The first that loads wins; a config that throws while loading is skipped
with a warning.

Only a **safe allowlist** of fields is merged from it:

- `resolve.alias`
- `css` (its `postcss` is dropped — an auto-detected PostCSS pipeline would conflict with
  Designbook's own CSS pipeline)
- `optimizeDeps` (`include` / `exclude`)
- `define`

Its **`plugins` are never merged as-is** — a framework plugin would hijack the dev server (see
[plugin inheritance](#plugin-inheritance) below).

If the monorepo scan finds **more than one** candidate vite config and can't tell which is the
right app, it picks none and suggests adding a sidecar to disambiguate — so ambiguity fails
safe rather than grabbing the wrong package's config.

Run with `--debug` to log which sidecar/repo config was merged and whether the Next shims were
applied.

## The `designbook.vite.*` sidecar

When auto-detection isn't enough, drop a `designbook.vite.{ts,mts,js,mjs}` next to your
`designbook.config.*`. It's a **partial** Vite config loaded via Vite's own loader (so it can
be TypeScript), and it's full-trust — higher precedence than the auto-detected repo config.
Only these fields are read:

- `resolve.alias` (object **or** array/regex form)
- `resolve.dedupe`
- `css` (full trust — its `postcss` is **not** stripped)
- `optimizeDeps`
- `define`
- `plugins` — uniquely for the sidecar, these are appended **after** Designbook's own plugins.
  This is the seam for build-time transforms like Lingui or svgr.

```js
// designbook.vite.mjs — next to your designbook.config.*
export default {
  resolve: {
    alias: { "@myrepo/internal": new URL("./src/internal", import.meta.url).pathname },
  },
  plugins: [/* e.g. lingui(), svgr() */],
};
```

## Plugin inheritance

Designbook follows a "Storybook model": your repo's Vite **plugins are inherited**, but
through a **deny-list**, not blindly. Some classes of plugin actively break an embedded dev
server, so they're filtered out:

- **Framework plugins** (React Router, Remix, Next, Astro, Svelte(Kit), Solid, Qwik, PWA,
  Nitro) — they'd hijack the dev server and its routing.
- **Dev-server / middleware plugins** — they claim routes the workbench itself needs.
- **Write-side-effect plugins** (codegen / `dts` generators) — they write generated files into
  your repo as a side effect of the dev server running.
- **Linters / type-checkers** — they spawn their own checker against the wrong root.
- **Vite-internal plugins** — Designbook already provides these.

Anything whose name collides with one of Designbook's own plugins is also dropped. Your
**React plugin is a special case**: if your repo ships `@vitejs/plugin-react` (or the SWC
variant), Designbook swaps *your* React plugin into its own React slot, so your Babel/SWC
config (Lingui macros, Emotion, etc.) rides along.

## tsconfig paths

Every workspace package's own `compilerOptions.paths` is honored **per-importer** via
`vite-tsconfig-paths` — so `@/` can mean different things in different packages of a monorepo,
matching how your app actually resolves them. This is on automatically; you don't configure
it.

## Next.js shims

When your repo depends on `next`, Designbook auto-aliases `next/link`, `next/navigation`,
`next/image`, and `next/dynamic` to inert stubs (plain `<a>` / `<img>`, no-op router hooks) so
components render outside a Next runtime, and defines `process.env` so Next client modules
don't throw at module scope. A sidecar or repo alias for those ids overrides the shim. See
[Next.js](/repo/nextjs/) for the current status.
