---
title: What is Designbook?
description: Your React app from every angle — a full view over your running app with live, editable tokens/copy/flags/code and an embedded coding agent that lands every edit as real code.
---

Designbook is a **design workbench for React repos**. Point it at your codebase and it opens
your running app inside one full-screen view — every discipline's tools around the same live
app, not a separate mockup. By default it **injects into your app's own Vite dev server**: your
components hot-reload exactly as they do in your own app, because it *is* your app. A round
pencil button on your running app opens the full view; a play button in the same spot closes it
and hands you back to the untouched app.

What sets it apart from a component gallery is that it is **built for every discipline to
change things**, not just look at them. The full view exposes design tokens, translated copy,
and feature flags as editable views of the same codebase through *adapters* — each discipline
reads and edits its own layer, and every edit is written back to its real source of truth: your
theme CSS, your locale JSON, your flag files. For bigger changes there's an embedded **Pi
coding agent** in Chat: describe what you want and it applies the change as real edits to your
source files, staged so you can review, bake, or discard it before it touches your branch.
Nothing here is a throwaway mockup; the output is always code.

A useful way to think about it: each panel shows the same app from a different angle. The
theme adapter is the design view, the text adapter is the content view, flags are the product
view, the code panel is the engineering view — much as a building gets one drawing per trade,
each one true, none complete alone. The views are not copies: they all read and write the same
files, so an edit made in one is immediately visible in every other.

## Feature highlights

- **One full view over your real app** — select anything, in any route, at any state — no
  separate canvas to browse first. See [The full view](/concepts/full-view/).
- **Chat with memory** — a real, continuous conversation per branch: select something, ask
  about it, select something else, and the agent remembers what you discussed. Ask for options
  and each renders as a live, in-place preview card you can flip between. See [Chat & the Pi
  agent](/concepts/agent/).
- **Changesets on git** — every exploration is isolated as a hidden git branch until you bake
  it in, branch it out for review, or discard it — your real branch stays pristine the whole
  time. See [Changesets & the Changes panel](/concepts/changesets/).
- **History explorer** — a timeline graph of a conversation's changesets and turns; roll back
  to any point, or fork a new direction from it. See [History explorer](/concepts/history/).
- **Props panel** — typed controls generated from your TypeScript; editing one writes the JSX
  attribute at the selected instance. See [Props panel](/concepts/props-panel/).
- **Adapters** — edit theme tokens (light/dark, variants), translated text (i18next), and
  per-tenant feature flags directly on your app; changes persist to your files.
- **Code panel** — view (and edit) the real source of the selected component.
- **Figma round-trip** — push components to Figma as native layers with variable-bound
  styles, and pull designer edits back as a target for the agent to apply. See
  [Figma integration](/figma/).
- **Your real build pipeline** — in injected mode your components compile through your app's
  own Vite, so its aliases, tsconfig paths, and providers apply and previews match production.
  (Host mode uses an embedded Vite that bridges those parts in, auto-detected from your repo.)
- **Branch instances** — switch branches in the full view and designbook works from a
  git-worktree-backed checkout of it, with its own agent session and dev server.

## How it works

In **injected mode** (the default), designbook adds a `designbookPlugin()` to a variant of your
own Vite config. That plugin injects the full-view overlay into your running app and compiles
your `designbook.config.tsx` through **your** bundler — so your components render with your
real aliases, styling, and providers. A separate **sidecar** process (`designbook dev`) runs
the Pi agent and write-back endpoints on a stable port and proxies your app behind it, giving
you one URL. The overlay lives in a shadow DOM so it can't collide with your styles.
See [Injected mode](/getting-started/injected-mode/).

**Host mode** (`designbook [config]`, for repos with no runnable app) instead starts a single
Node server: `/api/*` hosts the Pi agent and write-back endpoints, and everything else is an
embedded Vite dev server (in middleware mode) that compiles the full view and your components
via the `virtual:designbook-config` module. Because host mode runs your real code without your
app's dev server, it bridges in the parts of your build your components need to resolve and
compile — see [Using with your repo](/repo/compat/).

## Next steps

- **[Install & run](/getting-started/install-and-run/)** — get the full view open on your repo.
- **[Injected mode](/getting-started/injected-mode/)** — the plugin, config variant, and overlay.
- **[Your first config](/getting-started/first-config/)** — a minimal config, then how to grow it.
