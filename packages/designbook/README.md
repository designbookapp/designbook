# designbook

Design workbench for React repos — a live canvas of your real components plus a Pi coding agent, aimed at designers. designbook **injects into your app's own Vite dev server**.

```bash
npm i -D @designbookapp/designbook
npx @designbookapp/designbook init      # scaffold config + vite variant + scripts
npm run design           # → http://localhost:8787/
```

The package is `@designbookapp/designbook`; its CLI command is `designbook`. Pre-install one-shots
use the package name (`npx @designbookapp/designbook init`); once installed, `package.json` scripts
and `npx designbook` use the bare `designbook` command.

## How it works (injected mode)

designbook adds a toolbar pill to your app that expands into a full-screen workbench overlay (in a shadow DOM, so it can't collide with your styles). Your components render through your app's own bundler, styling, and providers.

- **`designbookPlugin()`** — added to a `vite.designbook.config.ts` variant that wraps your real Vite config (see the "Injected mode" docs page). Injects the toolbar/overlay client and exposes your `designbook.config.tsx` to it. Options: `config` (path, auto-discovered), `serverUrl` (sidecar origin, must match the sidecar `--port`), `autoExpand`.
- **`designbook dev`** — the `design` script. Runs the API/agent/figma sidecar on a stable port and proxies your app's own dev server behind it, so one URL survives restarts; a recovery page (with Pi chat) shows when the target is down; `/__designbook/...` deep links open a specific component.
- **`designbook init`** — scaffolds `designbook.config.tsx` (a `fromGlob` registry), the `vite.designbook.config.<ext>` variant (wrap-your-config + checker-drop), and the `design` / `dev:designbook` scripts. Detects your Vite config, package manager, and components dir. Idempotent; `--force` to overwrite. Flags: `--dir`, `--app-port`, `--port`.

## Host mode

No runnable app (a standalone component library)? `designbook [config]` serves the workbench from designbook's own embedded Vite dev server instead of injecting into yours.

```bash
designbook [config] [--port 8787] [--host localhost] [--root <repo root>] [--no-open] [--debug]
```

`config` defaults to `designbook.config.{tsx,ts,jsx,js}` in the current directory. The project root (the repo the agent works in) defaults to the git root above the config file; override with `--root` or `DESIGNBOOK_CWD`. On start the workbench opens in your browser (disable with `--no-open`; auto-disabled for non-TTY/CI and worktree-spawned instances). In host mode the CLI starts a single Node server: `/api/*` for the Pi agent, everything else an embedded Vite dev server compiling the workbench UI and your components via the `virtual:designbook-config` module.

## Config API

```tsx
// designbook.config.tsx
import { defineConfig, fromGlob, useDataset } from "@designbookapp/designbook/config";

export default defineConfig({
  title: "My app",
  sets: [
    {
      id: "primitives",
      title: "Primitives",
      // Recommended: one lazy, code-split entry per file. One broken component
      // is one red cell; source attribution comes free from the glob key.
      components: fromGlob(import.meta.glob("./src/components/*.tsx")),
    },
    {
      id: "product",
      title: "Shop/Product",
      components: { ProductCard, ...productAtoms }, // static registration also works
      wrapper: ProductWrapper, // provides context; reads useDataset()
    },
  ],
  datasets: [{ id: "default", label: "Default", data: { ... } }],
  providers: [ThemeProvider, LanguageProvider],
  sourceModules: import.meta.glob("./src/composite/**/*.tsx", { eager: true }),
  i18n: {
    resources: import.meta.glob("./locales/*/app.json", { eager: true, import: "default" }),
    defaultLocale: "en-US",
    localePath: "./locales/{locale}/{namespace}.json",
  },
  themes: [{ id: "forest", label: "Forest", cssVars: { root: { "--primary": "…" } } }],
});
```

See `src/config/index.ts` for the full types.

## Text adapters

The canvas text tool attributes each rendered string back to its source of truth and saves edits there. That mapping is pluggable: a **text adapter** claims a text node, provides its display value + editor capabilities, and knows how to persist a change. Adapters run as an ordered chain — the first to claim a node wins.

Two adapters ship in `@designbookapp/designbook/adapters`:

- **`i18nextAdapter(i18n)`** — keyed i18next catalog editing: invisible-marker attribution, the rich placeholder/plural editor, live language switching, and write-back to your locale JSON. This is what the `i18n` config field turns on.
- **`sourceLiteralAdapter()`** — a built-in fallback that edits a plain string literal directly in its `.tsx` source, but only when the rendered text matches exactly one literal in the owning component's file (ambiguous matches fall through to the "hardcoded string" callout).

Setting `i18n` is sugar: an `i18nextAdapter(i18n)` is prepended automatically when no i18next adapter is listed, and `sourceLiteralAdapter()` is always appended last. So the default experience needs no `adapters` field. List adapters explicitly to add your own or control ordering:

```tsx
import { defineConfig } from "@designbookapp/designbook/config";
import { i18nextAdapter, sourceLiteralAdapter } from "@designbookapp/designbook/adapters";

export default defineConfig({
  // …sets, sourceModules, providers…
  adapters: [
    myCatalogAdapter(),                       // custom adapter, tried first
    i18nextAdapter({ resources /* … */ }),    // keyed i18next editing
    sourceLiteralAdapter(),                    // plain-literal fallback
  ],
});
```

A custom adapter implements the `TextAdapter` interface (exported from `@designbookapp/designbook/config`):

```ts
type TextAdapter = {
  name: string;
  /** Runs once at boot; return locale plumbing if the adapter owns language state. */
  setup?(): Promise<{ Provider?; setLocale?; languages?; defaultLocale? } | void>;
  /** Claim a rendered text node (carry its own save), or return null to pass it on. */
  resolveText(hit: TextNodeHit): TextClaim | Promise<TextClaim | null> | null;
  /** Optional synchronous, side-effect-free hover preview. */
  previewText?(hit: TextNodeHit): TextClaim | null;
};
```

Adapters are browser code (the config runs in the workbench), so they may touch the DOM and `fetch` the designbook API. See `TextAdapter`, `TextClaim`, and `TextNodeHit` in `src/config/adapters.ts`.

Agent/API errors always log to the terminal; `--debug` (or `DESIGNBOOK_DEBUG=1`) additionally logs every API request and Pi agent event.

## Branch instances

Switching branches in the workbench creates a git worktree next to the repo (`<repo>-worktrees/<branch>`), installs dependencies, and starts a designbook instance on a deterministic port. The bin is resolved from the config file's directory upward, so monorepos work. If the repo builds designbook from source, add a `designbook:setup` script to the root package.json — it runs after each worktree install (this monorepo uses it to build `packages/designbook`).

Each instance's output (install, setup, and the running server) is appended to `~/.designbook/logs/<repo>--<branch>.log`; failure messages point there.

## Vite compatibility

designbook runs its own embedded Vite (with `configFile: false`) to compile the workbench UI, so it does not adopt the target repo's build config wholesale. Instead it bridges in the parts a repo's components need to resolve and compile, in this precedence order (highest wins):

1. **designbook's reserved aliases** — `@designbook-ui`, `@designbookapp/designbook/config`, `@designbookapp/designbook/adapters`. Always win.
2. **Explicit sidecar** — a `designbook.vite.{ts,mts,js,mjs}` next to your `designbook.config.*`. The full escape hatch.
3. **Auto-detected repo `vite.config.*`** — zero-config. Searched in the config's directory, then the project root, then a one-level scan of `apps/*`, `packages/*`, and `*/`. The first that loads wins. Only a **safe allowlist** is merged: `resolve.alias`, `css`, `optimizeDeps` (`include`/`exclude`), `define`. Its `plugins` are **never** merged (a framework plugin would hijack the dev server). A config that throws while loading is skipped with a warning.
4. **`tsconfig` paths** — every workspace package's own `compilerOptions.paths` is honored per-importer via `vite-tsconfig-paths` (so `@/` can mean different things in different packages).
5. **Next.js shims** — when the repo depends on `next`, `next/link` / `next/navigation` / `next/image` are auto-aliased to inert stubs (plain `<a>`/`<img>`, no-op router hooks) so components render outside a Next runtime. A sidecar/repo alias for those ids overrides the shim.

### The `designbook.vite.*` sidecar

A partial Vite config, loaded via Vite's own loader (so it can be TypeScript). Only these fields are read: `resolve.alias` (object **or** array/regex form), `resolve.dedupe`, `css`, `optimizeDeps`, `define`, and — uniquely for the sidecar — `plugins`, which are appended **after** designbook's own (the seam for Lingui, svgr, etc.). Example:

```js
// designbook.vite.mjs — next to your designbook.config.*
export default {
  resolve: {
    alias: { "@myrepo/internal": new URL("./src/internal", import.meta.url).pathname },
  },
  plugins: [/* e.g. lingui(), svgr() */],
};
```

Run with `--debug` to log which sidecar/repo config was merged and whether the Next shims were applied.

## Notes

- The embedded Vite reserves the `@designbook-ui` alias for the workbench's own source (renamed from `@ui` so it can't squat a consumer repo that uses `@ui`), plus `@designbookapp/designbook/config` and `@designbookapp/designbook/adapters`. The consumer repo's own `tsconfig` path aliases are honored via `vite-tsconfig-paths`, and its `vite.config` / an explicit `designbook.vite.*` sidecar can contribute more — see [Vite compatibility](#vite-compatibility).
- Pi credentials come from the SDK's standard auth flow (`~/.pi/agent/auth.json`) and provider env vars.
