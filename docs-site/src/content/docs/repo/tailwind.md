---
title: Tailwind
description: How Designbook handles Tailwind — v4 native, and the status of v3 semantic-token support.
---

In [injected mode](/getting-started/injected-mode/) your components compile through your app's own
Vite, so your existing Tailwind setup applies unchanged. This page is about **host mode**, where
Designbook compiles your components through its embedded Vite, which includes `@tailwindcss/vite`
(Tailwind **v4**). How it behaves depends on whether your repo uses Tailwind.

## Tailwind v4 (native)

If your repo uses Tailwind, Designbook detects it and processes your project files with
Tailwind **as normal** — the plugin runs globally, exactly as it would in your own build. This
is the supported path; a Tailwind v4 repo works out of the box.

Detection is broad: Designbook treats the repo as a Tailwind repo if `tailwindcss` is declared
anywhere in the config → project-root → workspace-root chain, if a workspace member one level
down declares it, or if your auto-detected `vite.config` carries a Tailwind PostCSS plugin.

## Repos that don't use Tailwind

If your repo does **not** use Tailwind, Designbook restricts Tailwind's transform to its own UI
source so it never touches your files. This matters for repos that use Sass but not Tailwind:
`@tailwindcss/vite` registers a pre-transform that runs before Vite's CSS pipeline, and if it
saw your raw `.scss` it would choke on Sass-only syntax. Scoping the transform to Designbook's
UI keeps your Sass compiling normally. This is automatic — there's nothing to configure.

## Tailwind v3

Tailwind v3 repos are bridged automatically. When Designbook detects an installed Tailwind v3,
it loads your `tailwind.config.{js,cjs,mjs,ts}` (presets included) through **your own**
`tailwindcss/resolveConfig`, and generates a v4 `@theme` mapping from the resolved
`theme.colors`, `borderRadius`, and `fontFamily` — so semantic utilities like `bg-primary`
(→ `hsl(var(--primary))`) work in designbook without any configuration. Your `darkMode`
setting (`class` or a custom selector) is carried over as a dark variant.

Two details to know:

- **Import your theme stylesheet.** The generated mapping references your CSS custom
  properties (`--primary` etc.), which live in your own stylesheet — import it in
  `designbook.config.tsx`. Legacy `@tailwind base/components/utilities;` directives in that
  file are stripped automatically so it loads cleanly under v4.
- **`@apply` in global CSS is left as-is.** Component classes generate normally, but v3-style
  global `@apply` rules (e.g. `* { @apply border-border }`) are not converted.

In a monorepo with mixed Tailwind majors, the version is resolved per config file — a v4 docs
app doesn't stop a v3 UI package from being bridged. If detection picks the wrong config, a
[sidecar](/repo/compat/#the-designbookvite-sidecar) can override the Vite side.
