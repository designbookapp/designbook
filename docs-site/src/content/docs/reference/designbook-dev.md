---
title: designbook dev
description: The sidecar + proxy front for injected mode — a stable URL, recovery page, deep links, HMR-defer, and reload rehydration.
---

`designbook dev` is the command behind the `design` script. It runs the API/agent/Figma/worktree
**sidecar** on a stable port and **proxies your app's own dev server** behind it, so you connect
to one URL that survives restarts, branch switches, and target-server crashes.

```bash
designbook dev [options]
```

For the plugin and config-variant side of injected mode, see
[Injected mode](/getting-started/injected-mode/).

## The sidecar + proxy front

Your app's Vite dev server (running the [config variant](/getting-started/injected-mode/), so it
loads `designbookPlugin()`) listens on the **app port**. You don't open that port. Instead
`designbook dev` runs the sidecar on a **stable port** and reverse-proxies the app behind it:

- `/__designbook/api/*` is served by the sidecar itself — the Pi agent, Figma bridge,
  worktree/branch instances, and the write-back endpoints full view uses. The injected
  client targets this namespace automatically.
- everything else — **including your app's own `/api/*`** — is proxied through to your app's
  dev server. designbook no longer intercepts plain `/api`, so an app with its own same-origin
  `/api` keeps working. (The sidecar also runs a **direct api port** at `--port` + 1 where
  plain `/api/*` is designbook's, for cross-origin use.)

The result is **one URL** for the whole thing. It stays stable across app restarts and across
worktree/branch switches, so you never chase a changing port.

:::tip[Open the sidecar URL, not the app port]
Connect to the sidecar port (default `http://localhost:8787/`), **not** the app's own dev-server
port. The app port renders your app without the sidecar's `/api/*` — the chat/agent won't work.
:::

## Recovery page

When the target dev server is down — still booting, crashed, or mid-reinstall after a branch
switch — the proxy has nothing to forward to. Instead of a broken connection, the sidecar serves a
**recovery page**: it explains the target is unavailable and keeps the **Pi chat** available, so you
can ask the agent to fix the thing that's stopping the dev server from starting. When the target
comes back, a normal reload returns you to the app.

## Deep links

`/__designbook` and `/__designbook/component/<setId>.<ComponentKey>` are deep links that
**auto-expand full view** on load — bootstrapping via a `sessionStorage` flag and a redirect to
`/`, so the app's own URL is never touched.

:::caution[The component-id suffix is currently a no-op]
The `<setId>.<ComponentKey>` suffix (e.g. `primitives.Card`) is still parsed, round-tripped
through `sessionStorage`, and read back on boot, but it's discarded rather than acted on. It used
to navigate straight to that entry on the old browsable component canvas; that canvas is retired
in the full-view rewrite, and nothing has replaced the "land on this specific component" behavior
yet. Today `/__designbook/component/<anything>` and bare `/__designbook` do the same thing: expand
full view wherever your app already is. If you were relying on the component target, that part no
longer works — only the auto-expand does.
:::

Handy for wiring an auto-expand link (e.g. from other tooling) into your app; not currently useful
for linking to a specific component.

## HMR-defer & reload rehydration

Two behaviors keep a reload from disrupting your work (both detailed in
[Injected mode](/getting-started/injected-mode/#hmr-safety)):

- **HMR defer** — Designbook's own writes never reload the app; an edit that forces a full reload is
  held while the overlay is open and shown as an "app updated — reload" pill, applied on click or on
  collapse.
- **Reload rehydration** — the workbench uses an in-memory router (your app's URL is never touched)
  and restores its own expanded/selection state across reloads.

## Flags

| Flag | Description |
| --- | --- |
| `-p, --port <port>` | Stable sidecar port you connect to. Default `8787` (env `DESIGNBOOK_PORT`). |
| `--host <host>` | Host to bind. Default `localhost`. |
| `--allow-lan` | Required to bind a non-loopback `--host` (e.g. `0.0.0.0` or a LAN IP). Without it, a non-loopback `--host` refuses to start — see [Security & trust model](/reference/security/). |
| `--read-only` | Restrict the Pi agent to read-only tools (no bash/edit/write) and reject the file-write data endpoints with `403`. |
| `--trust-project` | Trust this repo's `.pi/` directory (extensions, settings, system prompt) — same gate Pi's own CLI has. Default: untrusted. |
| `--root <dir>` | Project root the agent works in. Default: the git root above the config (env `DESIGNBOOK_CWD`). |
| `--target-url <url>` | Attach to an already-running target dev server instead of spawning one. |
| `--target-cmd <cmd>` | Command to spawn the target dev server. Default: the project's package.json `dev` script — but the `design` script overrides it to spawn the Vite variant. |
| `--target-cwd <dir>` | Directory to spawn `--target-cmd` in. Default: the nearest `package.json` at/above the config — the **app package**, where the scripts live, not the git root. |
| `--target-port <port>` | Force/known target port. Skips log-based ("Local:") discovery. |
| `--api-port <port>` | Direct api port where plain `/api/*` is designbook's, unproxied. Default `--port` + 1. Warns and is skipped if taken; the proxy's `/__designbook/api` still works. |
| `--no-open` | Don't open a browser. |
| `--debug` | Verbose logging. |

## Auto-recovery & backoff

If the target dev server crashes, `designbook dev` restarts it **forever** with escalating
backoff — 1s → 2s → 5s → 10s → 30s (capped), reset to the start on a clean boot. After 5
consecutive fast failures it stops logging every restart and prints one
`target failing repeatedly: <last stderr> — retrying every 30s` line. Fix the app (often from
the recovery page's Pi chat) and it recovers on its own.

## Port already in use

If the stable port is taken, `designbook dev` prints
`port <n> in use — another designbook running? --port to change` and exits (no stack trace).
Pick a free `--port`. The direct api port (`--port` + 1) warns and is skipped if taken; move
it with `--api-port`.

## The `design` / `dev:designbook` script convention

`designbook dev` must spawn your app through the [Vite variant](/getting-started/injected-mode/), so
the convention wires two scripts together:

```jsonc
{
  "scripts": {
    "dev:designbook": "vite --config vite.designbook.config.ts --port 3013",
    "design": "designbook dev --port 8787 --target-cmd \"npm run dev:designbook\" --target-port 3013"
  }
}
```

- **`dev:designbook`** runs Vite with the config variant on the app port (`3013` here).
- **`design`** runs the sidecar on the stable port (`8787`), tells it to spawn the target with
  `--target-cmd "npm run dev:designbook"`, and passes `--target-port` so it skips log-based port
  discovery.

Keep the plugin's `serverUrl` equal to `--port`. Then:

```bash
npm run design
# → open http://localhost:8787/  (the sidecar proxy, NOT the app port)
```

`designbook init` writes both scripts for you — see [`designbook init`](/reference/init/).

## See also

- **[Injected mode](/getting-started/injected-mode/)** — the plugin and config variant.
- **[Install & run](/getting-started/install-and-run/)** — the full quickstart.
- **[CLI reference](/reference/cli/)** — all three subcommands.
- **[Security & trust model](/reference/security/)** — `--read-only`, `--allow-lan`, `--trust-project`, and the trust model behind them.
