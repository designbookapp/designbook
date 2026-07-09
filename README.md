# designbook

**One product. Every angle.**

designbook opens your React app from every angle — designers edit theme tokens, writers edit every string in every language, product flips feature flags, engineers see the code — all on the running app, with every edit landing as a real change in the repo. For bigger changes there's an embedded [Pi](https://github.com/badlogic/pi-mono) coding agent.

designbook **injects into your app's own Vite dev server**: it adds a toolbar pill that expands into a full-screen workbench overlay — canvas in the center, files/changes/Figma/adapters on the left, chat/props/code on the right. Your components render through your app's real bundler, styling, and providers — no second build, no copied config. Every view is derived from the code — nothing is drawn by hand, so nothing drifts. A sidecar process serves the agent/API on a stable port and proxies your app behind it, so one URL survives restarts and crashes.

## Quickstart

```bash
npm i -D @designbookapp/designbook          # add as a dev dependency (pnpm/yarn/bun work too)
npx @designbookapp/designbook init          # scaffold the config + vite variant + scripts
npm run design               # start the workbench → http://localhost:8787/
```

`init` detects your Vite config, package manager, and a components directory, then writes:

- `designbook.config.tsx` — a `fromGlob` registry of what the canvas shows.
- `vite.designbook.config.ts` — your real Vite config plus `designbookPlugin()`.
- `design` / `dev:designbook` scripts.

Zero files to hand-write. Open the sidecar URL (not the app port), click the `◈ designbook` pill, and your components appear on the canvas.

## Features

- **Live canvas** — every component rendered through your app's real bundler, styling, and providers; matrix axes for variants; drill into a component's detail page.
- **Flows** — group screens/components into a named sequence for a walkthrough, one flow per set by default or your own custom grouping.
- **App page** — the app's own current route, live, in an iframe on the canvas — not a mock. Page tools (select, prompt, in-place text edit) work inside it too.
- **Page tools** — select a component or click a string directly on the running app (not just the canvas) to prompt Pi against it or edit the text in place; edits write back to real source.
- **Per-cell isolation** — glob-registered entries are lazy and code-split; one broken component is one red cell with a retry, never a dead workbench.
- **Pi coding agent** — an embedded chat tab that turns design edits into real code changes; git-worktree branch instances.
- **Changes tab** — a live list of your repo's edited/new/deleted files; click through to an in-editor diff, discard a file's changes, and see "Edited" badges on the affected canvas components.
- **Props inspector** — select a rendered component and read its live props (or a DOM node's tag/classes) in the side panel.
- **Adapters** — theme, i18n/text, feature flags, and custom dimensions the canvas can switch; injected adapters can follow the app's live state (`hostContext`).
- **Figma round-trip** — token ↔ variable sync, component push as native Figma layers, and pull of designer edits back as a declarative target the agent applies — all via a local plugin + WebSocket bridge.
- **HMR-safe** — designbook's own writes never reload your app; full reloads are deferred while the overlay is expanded, then applied on collapse.
- **Reload rehydration** — a memory router keeps your app's URL untouched; the workbench restores its own state across reloads.
- **Code panel** — select a rendered component to see and edit its true source (attribution comes free from the glob key).

## Host mode

No runnable app (a standalone component library, say)? Run `designbook <config>` to serve the workbench from designbook's own embedded Vite dev server instead of injecting into yours. Same canvas and agent; see the docs "Host mode" page.

## Docs

Full docs at **[docs.designbook.app](https://docs.designbook.app)** (source in `docs-site/`, an Astro Starlight site). Key pages: **Injected mode** (`designbookPlugin` options), **`designbook dev`** (sidecar/proxy/recovery/deep links/HMR), **`designbook init`**, **fromGlob & lazy entries**, and the adapter reference. The complete config API lives in `packages/designbook/src/config/index.ts`.

## Monorepo layout

- `packages/designbook` — the npm package: CLI (`bin/designbook` → host mode, `dev`, `init`), the Vite plugin + sidecar, workbench UI, and the `@designbookapp/designbook/config` public API.
- `examples/` — small apps consuming designbook: `demo` (Vite + React + Tailwind shop), `i18n-app` (i18next adapter), `tw4-app` (Tailwind v4), `init-app` (a bare app to try `designbook init` on).
- `docs-site/` — the documentation site (Astro Starlight).

## Development

```bash
pnpm install
pnpm --filter '@designbookapp/designbook' build        # compile cli/plugin/config + UI to dist
pnpm --filter '@designbookapp/designbook' test:run     # vitest
pnpm --filter '@designbookapp/designbook' check-types  # tsc
```

Pi credentials are resolved by the SDK's standard auth flow (`~/.pi/agent/auth.json`, then provider environment variables). Two ways to connect a model for the chat tab — the rest of the workbench works without one:

- **OAuth / subscription** — run `npx designbook login` in your project (the Pi CLI ships with designbook, no separate install), then `/login`. Credentials land in `~/.pi/agent/auth.json`; click **Retry connection** in the chat tab to pick them up without restarting. (`npx designbook pi …` is the general escape hatch that passes through to the bundled Pi CLI.)
- **API key** — set a provider key, e.g. `ANTHROPIC_API_KEY`, in the shell that runs `npm run design`.

Without either, the chat tab shows a setup callout instead of the prompt input.

## Status

Early, 0.x. The core loop (inject → canvas → code panel → agent) is solid across several real repos; APIs can still shift between minor versions. See `CHANGELOG.md` for what's landed. Bug reports and feature requests are welcome on the [issue tracker](https://github.com/designbookapp/designbook/issues); see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
