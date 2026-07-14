# Designbook — design

2026-07-03. Storybook-like tool for designers: run `designbook ./designbook.config.tsx` inside a React repo, get a web workbench (canvas of live components + Pi chat agent that edits the repo). Migrated from the `design/` MVP (standalone app hardcoded to the commerce-portals monorepo).

## Decisions

Asked user, no response — went with recommended options:

1. **Architecture: embedded Vite + virtual module.** The `designbook` CLI starts one Node server: `/api/*` routes (Pi agent, worktrees, i18n edits) + Vite dev-server middleware for everything else. The workbench UI ships as source inside the npm package and is compiled by the embedded Vite; the user's config file is exposed to the UI as `virtual:designbook-config`. Like Ladle/Storybook. HMR of user components for free; zero changes to the user's own vite config.
2. **Repo layout: pnpm monorepo.** `packages/designbook` (the npm package) + `examples/demo` (consumer app). `design/`, `cruises/`, `components/` remain untouched reference copies.
3. **Scope: full migration, config-driven.** Workbench, DesignChat, Pi server, worktrees, i18n text editing all ported now. Every hardcoded monorepo path becomes a config option.
4. **Config API: typed `defineConfig`** mirroring the MVP's `ComponentSet` shape so migration is mechanical.

## Layout

```
designbook/
├─ pnpm-workspace.yaml, package.json (private root)
├─ packages/designbook/          npm package "designbook"
│  ├─ bin/designbook.js          thin launcher
│  ├─ src/cli/                   arg parsing (config path, --port, --host)
│  ├─ src/node/                  http server, /api routes, pi session, worktrees,
│  │                             jsonEdit, vite middleware + virtual-config plugin
│  ├─ src/config/                defineConfig + shared types (browser-safe)
│  ├─ src/ui/                    index.html, app shell, Workbench, DesignChat,
│  │                             components/ui (shadcn-style chrome), i18n, theme
│  └─ package.json               exports: "." (node), "./config", bin: designbook
├─ examples/demo/                vite react app, consumer of designbook
│  ├─ designbook.config.tsx
│  ├─ src/components/ui/         shadcn-like lib (button, card, badge, …)
│  ├─ src/composite/<domain>/    variants/*.tsx + atoms.tsx (cruises pattern)
│  ├─ src/providers/             ThemeProvider, LanguageProvider
│  └─ locales/<locale>/app.json
└─ design/ cruises/ components/  reference only (from commerce-portals)
```

## Config API

Browser-side module, loaded via `virtual:designbook-config`:

```ts
import { defineConfig } from "@designbookapp/designbook/config";

export default defineConfig({
  title: "Demo",
  sets: [...],                       // ComponentSet[] — id, title, components, wrapper?, overrides?
  flows: [...],                      // optional; screens w/ registryId or wireframe fallback
  datasets: [{ id, label, data }],   // generic; wrappers read via useDataset()
  sourceModules: import.meta.glob([...], { eager: true }),  // component → source-path inference
  providers: [ThemeProvider, ...],   // wrap the canvas
  i18n: {
    resources: import.meta.glob("./locales/*/app.json", { eager: true, import: "default" }),
    languages: [{ id: "en-US", label: "EN" }, ...],
    defaultLocale: "en-US",
    namespace: "app",
    localePath: "./locales/{locale}/{namespace}.json",  // server write-back template
  },
  themes: [{ id, label, cssVars?, class? }],   // scoped to canvas container
  viewports?: [...],
});
```

Because `import.meta.glob` needs literal paths, all filesystem-shaped concerns (locales, source modules) are evaluated **in the user's config file**, relative to it — designbook itself contains no repo-specific paths.

## Migration map (design/ → packages/designbook)

| MVP file | Destination |
|---|---|
| `src/server/index.ts` | `src/node/api.ts` + `src/node/server.ts`; static serving replaced by vite middleware; monorepo root → project root (config dir / git root); locale write path from client request, validated inside project root |
| `src/server/worktrees.ts`, `jsonEdit.ts` (+tests) | `src/node/` as-is |
| `src/i18n.ts` | `src/ui/i18n.ts`, resources/languages from config; own i18next instance via `I18nextProvider` (replaces `@commerce/i18n` `getI18nInstance`) |
| `componentSets.ts` | deleted — type moves to `src/config/types.ts`, content moves to demo config |
| `componentRegistry.ts` | config-driven (`sets` + `sourceModules`) |
| `datasets.ts`, `tenantTheme.ts`, `flows.ts`/`flowSpec.ts` content | config-driven (`datasets`, `themes`, `flows`); machinery stays |
| `setWrappers.tsx`, `CruisePreviewCanvas/`, `funnels/` | dropped; demo builds its own wrappers. `CanvasNodeSelection` type moves into Workbench |
| `components/ui/*`, `DesignChat/`, rest of `Workbench/` | ported with import updates |

## Demo app

Small but exercises everything: 2–3 composite domains (e.g. product, listing) with variants + atoms; shadcn-style ui lib; ThemeProvider (light/dark + brand cssVars) and LanguageProvider (i18next, en-US/fr-FR/es-419) — both registered in config so designers can flip theme/language on the canvas; tailwind v4.

## Error handling / testing

- Server: same JSON error envelope as MVP; config load errors surface in terminal + browser overlay (vite).
- Migrated unit tests: `jsonEdit.test.ts`, `i18nMarkers.test.ts` (vitest).
- Smoke: `designbook examples/demo/designbook.config.tsx` serves UI + `/api/state`.

## Out of scope (future)

- Non-React frameworks; npm publishing/CI; auth; production build of the workbench (`designbook build`).

## Unresolved questions

- Package name "designbook" availability on npm — placeholder for now?
- Pi credentials flow in consumer repos (assumes `~/.pi/agent/auth.json`) ok?
- Keep tenant font-pack loading? Dropped for now; themes = cssVars only.
