---
title: designbook init
description: Scaffold the injected-mode files — designbook.config.tsx, the Vite variant, and the design scripts — into a Vite app.
---

`designbook init` scaffolds everything [injected mode](/getting-started/injected-mode/) needs into a
Vite app: a `.designbook/config.tsx`, a Vite config variant, and the `design` / `dev:designbook`
scripts. Run it once from your app's root.

```bash
npx @designbookapp/designbook init [options]
```

## What it detects

`init` inspects the current directory and works out:

- **The Vite config** — the first of `vite.config.ts`, `.mts`, `.js`, `.mjs`, `.cts`, `.cjs`. If
  none exists, it stops: Designbook injects into a Vite dev server, so non-Vite apps (including
  Next.js) aren't supported in injected mode.
- **The package manager** — from the lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
  `bun.lock(b)` → bun, otherwise npm. Used for the script commands and the printed next steps.
- **The components directory** — scans for directories of component files (Capitalized `.tsx`,
  excluding `*.{test,spec,stories}.tsx`), preferring `src/components`, then `src/ui`, `components`,
  `src`; ties broken by file count then shortest path. Override with `--dir`. If nothing is
  detected it defaults the glob to `../src/components/*.tsx` and warns. (Globs are relative to
  `.designbook/`, so they start with `../`.)

The config `title` is derived from your package.json `name` (e.g. `client-app` → "Client App").

## What it writes

Three things:

1. **`.designbook/config.tsx`** — a `fromGlob` registry template pointed at the detected components
   directory (glob relative to `.designbook/`, so `../…`), with a commented-out `overrides`
   example. `.designbook/` is THE designbook folder for the app (it also holds figma baselines).
   See [fromGlob & lazy entries](/config/from-glob/).
2. **`vite.designbook.config.<ext>`** — the Vite variant that wraps your real config, drops any
   `vite-plugin-checker`, appends `designbookPlugin()`, and sets `server.open: false`. The extension
   matches your base Vite config's. See [Injected mode](/getting-started/injected-mode/).
3. **`package.json` scripts** — `dev:designbook` (runs Vite with the variant on the app port) and
   `design` (runs `designbook dev` on the sidecar port, spawning the variant). Existing scripts are
   preserved unless they conflict — see idempotency below.

## Idempotency & `--force`

`init` is safe to re-run. It **won't overwrite** an existing `.designbook/config.tsx` or Vite variant
(it reports them as "kept"), and it won't clobber a `dev:designbook` / `design` script that already
differs from what it would write (reported as a conflict). Pass `--force` to overwrite files and
replace conflicting scripts. Scripts that already match exactly are left alone.

## Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--dir <path>` | detected | Components directory to register in the glob. |
| `--app-port <port>` | `3013` | Port the app's dev server listens on. |
| `--port <port>` | `8787` | Stable sidecar port you connect to (kept in sync with the plugin's `serverUrl`). |
| `--force` | — | Overwrite existing files / replace conflicting scripts. |
| `-h, --help` | — | Show help. |

## Next-steps output

On success `init` prints a summary and next steps, roughly:

```text
designbook init
  package manager   npm
  vite config       vite.config.ts
  components dir     src/components  (glob ../src/components/*.tsx)

  wrote   .designbook/config.tsx, vite.designbook.config.ts
  updated package.json scripts: dev:designbook, design

Next steps:
  1. Install designbook as a dev dependency if you haven't:
       npm i -D @designbookapp/designbook
  2. Point the glob in .designbook/config.tsx at your components
     (currently ../src/components/*.tsx).
  3. Start the workbench:
       npm run design
     → open http://localhost:8787/  (the sidecar proxy, NOT the app port)

  The Pi chat tab needs ANTHROPIC_API_KEY in the shell that runs "npm run design";
  the canvas, code panel, and deep links all work without it.
  Ports: --app-port (app dev server, now 3013) and --port (sidecar, now 8787).
```

## See also

- **[Install & run](/getting-started/install-and-run/)** — the quickstart `init` is part of.
- **[Injected mode](/getting-started/injected-mode/)** — what the scaffolded files do.
- **[`designbook dev`](/reference/designbook-dev/)** — the command the `design` script runs.
