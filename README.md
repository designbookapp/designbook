# designbook

**One product. Every angle.**

designbook opens your React app from every angle — designers edit theme tokens, writers edit every string in every language, product flips feature flags, engineers see the code — all on the running app, with every edit landing as a real change in the repo. For bigger changes there's an embedded [Pi](https://github.com/badlogic/pi-mono) coding agent with real memory across a conversation.

designbook **injects into your app's own Vite dev server**: a pencil button expands into one full-screen view — chat/changes/tokens/flags on the left, your app live in the center with a top bar of adapter pickers and a footer tool picker (select, edit text), props/code on the right. Your components render through your app's real bundler, styling, and providers — no second build, no copied config. Every view is derived from the code — nothing is drawn by hand, so nothing drifts. A sidecar process serves the agent/API on a stable port and proxies your app behind it, so one URL survives restarts and crashes.

## Quickstart

```bash
npm i -D @designbookapp/designbook          # add as a dev dependency (pnpm/yarn/bun work too)
npx @designbookapp/designbook init          # scaffold the config + vite variant + scripts
npm run design               # start designbook → http://localhost:8787/
```

`init` detects your Vite config, package manager, and a components directory, then writes:

- `designbook.config.tsx` — a `fromGlob` registry designbook uses to name and attribute components.
- `vite.designbook.config.ts` — your real Vite config plus `designbookPlugin()`.
- `design` / `dev:designbook` scripts.

Zero files to hand-write. Open the sidecar URL (not the app port), click the pencil button, and your app opens in the full view.

## Features

- **One full view over your real app** — select anything, in any route, at any state; no separate canvas to browse first.
- **Chat with memory** — a real, continuous conversation per branch, selection-anchored, with variant options rendered as live in-place preview cards.
- **Changesets on git** — every exploration is a hidden git branch until you bake it in, branch it out for review, or discard it; your real branch stays pristine.
- **History explorer** — a timeline graph of a conversation's changesets and turns, with rollback and forking.
- **Props panel** — typed controls generated from your TypeScript; editing one writes the JSX attribute at the selected instance's usage site.
- **Code panel** — select anything to see and edit its true source (attribution comes free from the glob key, or from a best-effort scan for unregistered elements).
- **Changes panel** — every changeset of the branch you're viewing, grouped by conversation, with active toggles, conflict badges, and per-changeset bake/branch/discard.
- **Adapters** — theme, i18n/text, feature flags, and custom dimensions, switchable from the full view's top bar; injected adapters can follow the app's live state (`hostContext`).
- **Figma round-trip** — token ↔ variable sync, component push as native Figma layers, and a declarative pull of designer edits back for the agent to apply — all via a local plugin + WebSocket bridge.
- **Per-cell isolation** — glob-registered entries are lazy and code-split; one broken component fails on its own, not the whole config.
- **HMR-safe** — designbook's own writes never reload your app; full reloads are deferred while the full view is open, then applied on close.
- **Branch instances** — switch branches and designbook works from a git-worktree-backed checkout, with its own agent session kept running in the background.

## Host mode

No runnable app (a standalone component library, say)? Run `designbook <config>` to serve the full view from designbook's own embedded Vite dev server instead of injecting into yours. Same UI and agent; see the docs "Host mode" page.

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

Pi credentials are resolved by the SDK's standard auth flow (`~/.pi/agent/auth.json`, then provider environment variables). Two ways to connect a model for chat — the rest of designbook works without one:

- **OAuth / subscription** — run `npx designbook login` in your project (the Pi CLI ships with designbook, no separate install), then `/login`. Credentials land in `~/.pi/agent/auth.json`; click **Retry connection** in the chat tab to pick them up without restarting. (`npx designbook pi …` is the general escape hatch that passes through to the bundled Pi CLI.)
- **API key** — set a provider key, e.g. `ANTHROPIC_API_KEY`, in the shell that runs `npm run design`.

Without either, the chat tab shows a setup callout instead of the prompt input.

## Status

Early, 0.x. The core loop (inject → full view → code panel → agent) is solid across several real repos; APIs can still shift between minor versions. See `CHANGELOG.md` for what's landed. Bug reports and feature requests are welcome on the [issue tracker](https://github.com/designbookapp/designbook/issues); see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
