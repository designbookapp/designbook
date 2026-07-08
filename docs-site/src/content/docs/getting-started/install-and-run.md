---
title: Install & run
description: Install designbook, scaffold it into your Vite app with designbook init, and open the workbench.
---

Designbook ships as a single dev-dependency package, `@designbookapp/designbook`, exposing a `designbook` CLI.
By default it runs in **[injected mode](/getting-started/injected-mode/)**: it injects into your
app's own Vite dev server, so your components render through your real bundler, styling, and
providers. You browse a stable proxy URL and a `◈ designbook` toolbar pill opens the workbench —
tools right on the page, or the full canvas.

## Quickstart

```bash
npm i -D @designbookapp/designbook       # or: pnpm add -D @designbookapp/designbook  /  yarn add -D @designbookapp/designbook
npx @designbookapp/designbook init       # scaffold config + vite variant + scripts
npm run design            # → open http://localhost:8787/
```

That's the whole path. What each step does:

1. **Install** — add `@designbookapp/designbook` as a dev dependency of the package that depends
   on your components. In a monorepo that's usually the app package, not the repo root — see
   [Monorepos](/repo/monorepos/). The package name is `@designbookapp/designbook`; the command it
   installs is `designbook`. Before it's installed, one-shot commands must use the package name
   (`npx @designbookapp/designbook init`); once it's a dev dependency, the bare `designbook`
   command works in `package.json` scripts and via `npx designbook`.
2. **`npx @designbookapp/designbook init`** — detects your Vite config, package manager, and components
   directory, then scaffolds three files: `designbook.config.tsx` (a [`fromGlob`](/config/from-glob/)
   registry), a `vite.designbook.config.<ext>` variant, and the `design` / `dev:designbook`
   scripts. Idempotent; re-run safely. See [`designbook init`](/reference/init/).
3. **`npm run design`** — runs [`designbook dev`](/reference/designbook-dev/): the sidecar on a
   stable port, proxying your app's dev server (loaded with `designbookPlugin()`) behind it.

:::tip[Open the sidecar URL, not the app port]
Open **http://localhost:8787/** (the sidecar proxy), not your app's own dev-server port. The app
port renders your app without the sidecar's `/api/*`, so the agent won't work.
:::

### Requirements

Injected mode needs a **Vite** dev server and **React ≥ 18**. Apps without a Vite dev server — a
standalone component library, or a Next.js app — use [host mode](#host-mode-no-runnable-app) below.

## After `init`

`init` writes a `designbook.config.tsx` pointed at a detected components directory, but you'll
want to check that glob and grow the config. Continue to
**[Your first config](/getting-started/first-config/)**, and read
[Injected mode](/getting-started/injected-mode/) to understand the plugin, the config variant, and
the pill → overlay flow.

If `init` can't scaffold cleanly (a non-standard Vite config, say), you can write the files by
hand — the [Injected mode](/getting-started/injected-mode/) page has the full Vite-variant template
and the plugin options.

## Authentication

The embedded Pi agent uses the Pi SDK's standard auth flow (`~/.pi/agent/auth.json`) and provider
environment variables — set `ANTHROPIC_API_KEY` in the shell that runs `npm run design` for the
chat tab. The canvas, code panel, and deep links all work without it. Agent and API errors always
log to the terminal; `--debug` logs every request and agent event.

## Host mode (no runnable app)

No runnable app to inject into — a standalone component library, or a Next.js repo? **Host mode**
serves the workbench from Designbook's **own embedded Vite dev server** instead of your app's:

```bash
designbook [config] [options]
```

With no argument it looks for a config file in the current directory, in order:

1. `designbook.config.tsx`
2. `designbook.config.ts`
3. `designbook.config.jsx`
4. `designbook.config.js`

Pass a path explicitly to use a different file:

```bash
designbook ./config/designbook.config.tsx
```

On start the workbench opens in your browser on **port 8787** by default. On macOS with a
Chromium-family browser, Designbook refocuses an existing workbench tab rather than opening a new
one. Disable auto-open with `--no-open` (also disabled automatically for non-interactive/CI runs
and for worktree-spawned [branch instances](/branch-instances/)).

### Host-mode options

| Option | Description |
| --- | --- |
| `-p, --port <port>` | Port to listen on. Default `8787` (env `DESIGNBOOK_PORT`). |
| `--host <host>` | Host to bind. Default `localhost`. |
| `--root <dir>` | Project root the agent works in. Default: the git root above the config file (env `DESIGNBOOK_CWD`). |
| `--no-open` | Don't open (or refocus) the workbench in a browser. |
| `--debug` | Verbose logging: API requests + Pi agent events. Errors are always logged (env `DESIGNBOOK_DEBUG=1`). |
| `-h, --help` | Show help. |

The **project root** is the repo the embedded agent edits — by default the git root above your
config file; override with `--root` / `DESIGNBOOK_CWD`. In host mode, Designbook runs its own
embedded Vite and bridges in the parts of your build your components need (aliases, tsconfig paths,
Next.js shims) — see [Vite compatibility](/repo/compat/). See the full
[CLI reference](/reference/cli/) for all three subcommands.

## Next steps

- **[Injected mode](/getting-started/injected-mode/)** — the plugin, config variant, and overlay.
- **[Your first config](/getting-started/first-config/)** — a minimal config you can grow.
- **[fromGlob & lazy entries](/config/from-glob/)** — register components with per-cell isolation.
