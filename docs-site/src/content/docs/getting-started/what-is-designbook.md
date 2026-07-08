---
title: What is Designbook?
description: A design workbench for React repos — a live component canvas plus an embedded coding agent that turns design edits into real code.
---

Designbook is a **design workbench for React repos**. Point it at your codebase, register
the components you want to work on in a `designbook.config.tsx` file, and Designbook opens
an infinite canvas that renders those components live — the same way Storybook does, but
running against your real source. By default it **injects into your app's own Vite dev
server**: your components compile through your app's real bundler, styling, and providers,
and hot-reload exactly as they do in your own app. A `◈ designbook` toolbar pill on your
running app opens a compact tool strip for selecting, prompting, and editing text right on
the page, or expands into the full workbench canvas.

What sets it apart from a component gallery is that it is **built for designers to change
things**, not just look at them. The canvas exposes design tokens, translated copy, and
feature flags as editable fields through *adapters*, and every edit is written back to its
real source of truth — your theme CSS, your locale JSON, your flag files. For larger
changes there is an embedded **Pi coding agent**: describe what you want in chat and it
applies the change as real edits to your source files. Nothing here is a throwaway mockup;
the output is code.

## Feature highlights

- **Live component canvas** — an infinite canvas of your registered components, grouped
  Storybook-style into sets, rendered through your app's own dev server with hot reload.
- **Live-app editing** — select a component, prompt Pi, or edit text in place directly on
  your running app — no need to open the full canvas for a quick change. See
  [Live-app editing](/concepts/page-tools/).
- **Flows** — arrange screens (real components or lightweight wireframes) into user
  journeys alongside the component sets.
- **Adapters** — edit theme tokens (light/dark, variants), translated text (i18next), and
  per-tenant feature flags directly on the canvas; changes persist to your files.
- **The Pi agent** — an embedded coding agent that turns chat requests into real file
  edits in your repo.
- **Code panel** — view (and edit) the real source of the selected component.
- **Figma round-trip** — push components to Figma as native layers with variable-bound
  styles, and pull designer edits back for the agent to apply.
- **Your real build pipeline** — in injected mode your components compile through your app's
  own Vite, so its aliases, tsconfig paths, and providers apply and previews match production.
  (Host mode uses an embedded Vite that bridges those parts in, auto-detected from your repo.)
- **Branch instances** — switch branches in the workbench and Designbook spins up a
  git-worktree-backed instance on its own port.

## How it works

In **injected mode** (the default), Designbook adds a `designbookPlugin()` to a variant of your
own Vite config. That plugin injects a toolbar pill and a lazily-loaded workbench into your
running app, and compiles your `designbook.config.tsx` through **your** bundler — so your
components render with your real aliases, styling, and providers. A separate **sidecar** process
(`designbook dev`) runs the Pi agent and write-back endpoints on a stable port and proxies your
app behind it, giving you one URL. The workbench overlay lives in a shadow DOM so it can't collide
with your styles. See [Injected mode](/getting-started/injected-mode/).

**Host mode** (`designbook [config]`, for repos with no runnable app) instead starts a single Node
server: `/api/*` hosts the Pi agent and write-back endpoints, and everything else is an embedded
Vite dev server (in middleware mode) that compiles the workbench UI and your components via the
`virtual:designbook-config` module. Because host mode runs your real code without your app's dev
server, it bridges in the parts of your build your components need to resolve and compile — see
[Using with your repo](/repo/compat/).

## Next steps

- **[Install & run](/getting-started/install-and-run/)** — get the workbench open on your repo.
- **[Injected mode](/getting-started/injected-mode/)** — the plugin, config variant, and overlay.
- **[Your first config](/getting-started/first-config/)** — a minimal config, then how to grow it.
