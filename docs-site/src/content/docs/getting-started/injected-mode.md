---
title: Injected mode
description: How designbookPlugin injects the workbench into your app's own Vite dev server via a config variant, a pill, and a shadow-DOM overlay.
---

Injected mode is how Designbook runs by default: instead of hosting its own server,
it **injects into your app's own Vite dev server**. Your components render through
your app's real bundler, styling, and providers — the same pipeline production uses —
and the workbench appears as a toolbar pill on your running app.

This page is the conceptual heart of that model. For the click-by-click setup, see
[Install & run](/getting-started/install-and-run/); most of it is scaffolded for you
by [`designbook init`](/reference/init/).

## What `designbookPlugin()` does

`designbookPlugin()` is a Vite plugin, imported from the `designbook` root export. Added
to your Vite config, it injects three things into the dev server:

- an agent/toolbar client script,
- your `.designbook/config.tsx`, compiled by **your** bundler (so your aliases, tsconfig
  paths, providers, and styles all apply),
- a lazily-loaded, prebuilt workbench chunk.

Your normal `vite build` is untouched — the plugin only runs in the variant config below.

### Options

`designbookPlugin(options)` takes:

| Option | Default | Description |
| --- | --- | --- |
| `config` | auto-discovered | Path to the config file (absolute, or relative to the Vite cwd). Discovered in the cwd if omitted — `.designbook/config.*` first, then legacy `designbook.config.*`. |
| `serverUrl` | `http://localhost:8787` | Origin of the sidecar. **Must equal the sidecar `--port`** (see [`designbook dev`](/reference/designbook-dev/)). The injected client calls designbook's api under `<serverUrl>/__designbook/api/*`, so your app's own `/api` is never shadowed. |
| `autoExpand` | `false` | Auto-open the overlay on load. |

## The `vite.designbook.config.ts` variant

The plugin goes into a **config variant** that wraps your app's real Vite config and
appends the plugin — it never edits your base config. Only the `design` script uses this
variant; the normal build path never sees it.

```ts
import { defineConfig, type ConfigEnv, type UserConfig } from "vite";
import { designbookPlugin } from "@designbookapp/designbook";
import baseConfig from "./vite.config";        // ← the app's real config

export default defineConfig((env: ConfigEnv): UserConfig => {
  const base = (
    typeof baseConfig === "function" ? baseConfig(env) : baseConfig
  ) as UserConfig;

  // Drop vite-plugin-checker — it can crash the dev server; pure dev noise.
  const plugins = (base.plugins ?? []).filter((p) => {
    const name = (p as { name?: string })?.name ?? "";
    return !String(name).includes("checker");
  });

  plugins.push(
    designbookPlugin({
      config: "./.designbook/config.tsx",
      serverUrl: "http://localhost:8787", // MUST match the sidecar --port
      // autoExpand: true,  // optional: open the overlay on load
    }),
  );

  return { ...base, plugins, server: { ...(base.server ?? {}), open: false } };
});
```

Two details in the template matter:

- **Checker drop.** `vite-plugin-checker` can crash the dev server, so the variant filters
  out any plugin whose name contains `checker`. If a different checker plugin slips through,
  widen the filter.
- **`server.open: false`.** The variant disables Vite's own browser auto-open — you open the
  sidecar URL, not the app port (see [`designbook dev`](/reference/designbook-dev/)).

Adjust the `baseConfig` import to your config's real filename and extension. If your base
config is a function, the wrapper calls it with the current `env`; if it's an object, it uses
it directly.

## Pill → tool strip → canvas → shadow DOM

Once the app is running through the variant, Designbook adds itself to the page without
touching your app's markup or URL:

- **Collapsed** — a `◈ designbook` toolbar pill sits in the bottom-right corner of your
  running app.
- **Click the pill** — a compact tool strip appears over the running app: select a live
  component, edit text in place, or prompt Pi, without leaving the page. See
  [Live-app editing](/concepts/page-tools/).
- **Open the full canvas** — from the strip's expand action (or a deep link), a full-screen
  overlay takes over. It renders inside a **shadow DOM**, so the workbench chrome can't collide
  with your app's CSS (and your app's CSS can't leak into the chrome). The canvas cells render
  your components in light DOM under your app's own React, providers, and styles.

Because the overlay lives in a sibling root, it survives even when your app crashes at boot —
the canvas mounts your components itself.

### HMR safety

Designbook's own write-backs (token, text, flag edits) never reload your app. When an edit
*does* force a full page reload — editing `index.html`, say — that reload is **deferred** while
the overlay is expanded and surfaced as an "app updated — reload" pill. It applies when you
click the pill, or automatically when you collapse the overlay, so a reload never yanks the
canvas out from under you mid-edit.

### Reload rehydration

Designbook drives the workbench with an in-memory router, so your app's own URL is never
touched. When a reload does happen, the workbench restores its own expanded/collapsed and
selection state — you come back to the same component you were looking at.

## Requirements

Injected mode needs a **Vite** dev server (React ≥ 18) to inject into. Apps without one —
a standalone component library, or a Next.js app (no Vite dev server) — use
[host mode](/getting-started/install-and-run/#host-mode-no-runnable-app) instead.

## Next steps

- **[Install & run](/getting-started/install-and-run/)** — the injected quickstart end to end.
- **[Live-app editing](/concepts/page-tools/)** — the tool strip and the App page.
- **[`designbook dev`](/reference/designbook-dev/)** — the sidecar + proxy that fronts it.
- **[`designbook init`](/reference/init/)** — scaffold the variant, config, and scripts.
- **[fromGlob & lazy entries](/config/from-glob/)** — register components with per-cell isolation.
