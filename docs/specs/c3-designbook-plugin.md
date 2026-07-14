# C3 spec — `designbookPlugin()` + sidecar

_Phase C3 of [runtime-topology.md](../runtime-topology.md). Goal: designbook becomes a dev-only dependency inside the target app's Vite build — a plugin injects a toolbar + the prebuilt workbench overlay into THEIR dev server, backed by an API-only sidecar. Host mode keeps working throughout; every stage lands green._

## Non-goals

No config codegen / per-cell dynamic imports (C4). No Next/webpack (C5). No host-context-provider getters (C4 — needs config in their build formalized). No behavior changes to workbench features.

## Design decisions (settled with Michael, do not re-litigate)

- **Never write their URL.** Injected mode must not touch `location.hash`/history — their router owns the URL. Workbench routing goes in-memory + sessionStorage.
- **Deep links** via a plugin-served dev route `/__designbook[/...]` — serves their app + auto-expands the overlay and navigates the memory router to the target.
- **Sidecar proxy front**: one stable URL for the user regardless of which worktree's dev server is live; recovery page (error + Pi chat) when their server is down.
- **Config still `designbook.config.tsx`**, imported through THEIR build (S1 proved zero bridging). C4 formalizes codegen; C3 does the simplest correct thing.
- **`serverUrl` threading**: all `/api/*` access goes through one helper reading the config store (today `serverUrl` is stored but dead — every call site hardcodes relative paths).
- **Adapters unchanged** — same config file, same runtime; they render inside the overlay canvas exactly as in host mode.

## Stages

### C3.1 — The plugin: inject toolbar + overlay into their dev server

New `src/node/plugin.ts`, exported as `designbookPlugin(options)` from the package root (`designbook`), options `{ config?: string /* path to designbook.config.tsx, default: auto-discover like the CLI */, serverUrl?: string /* sidecar origin; default http://localhost:8787 */, autoExpand?: boolean }`.

The plugin (dev-only: everything gated on `apply: "serve"`):

1. **`transformIndexHtml`** → append `<script type="module" src="/@id/virtual:designbook-boot">`. Separate script tag = separate module graph = their entry throwing cannot kill us (S1 boot-crash isolation).
2. **`virtual:designbook-boot`** (resolveId/load): a small module that
   - imports the user config (their pipeline compiles it — aliases, tailwind, providers all just work);
   - imports `@designbookapp/designbook/ui` (prebuilt dist) + `@designbookapp/designbook/ui/style.css` **as text** (`?raw`-style, or fetch once) — style.css must NOT be linked globally (Tailwind preflight would hit their app); it is passed via the `styles` option so it lands only in the shadow root;
   - renders the **toolbar** (collapsed state): small fixed-corner pill in its own shadow-DOM host + own React root (bundled into dist/ui or a tiny sibling entry — builder's call, but it must not depend on the workbench chunk loading);
   - lazy-loads the workbench only on first expand: `mountWorkbench({ container: document.body, config, configDir, serverUrl, isolation: "shadow", overlay: true, startCollapsed: true, styles })`, then drives `expand()/collapse()/toggle()` from the toolbar;
   - **crash listeners**: `window.onerror`/`unhandledrejection` surface an error badge on the toolbar with "open workbench anyway" (the canvas mounts components itself — S1 proved grid renders when their entry throws).
3. **serverUrl threading** (prerequisite refactor, do first): add `apiUrl(path: string): string` in `src/ui/designbook.ts` (joins stored `serverUrl` or returns path unchanged when unset) and convert EVERY `/api/*` call site to it — adapters (sourceLiteralAdapter, lingui, i18next, flags, theme), DesignChat (fetches + the `EventSource("/api/events")`), FigmaDeltaPanel, FigmaSyncControls, useWorktrees, CodePanel. Host mode passes no serverUrl → identical behavior.
4. **CORS**: sidecar must answer cross-origin requests from their dev-server origin (Access-Control-Allow-Origin reflecting localhost origins + private-network header; EventSource works cross-origin without credentials). Gate to localhost.

**Accept**: excalidraw integration WITHOUT the spike shim — `designbookPlugin()` added to `excalidraw-app`'s real vite config (a `vite.designbook.config.mts` variant is fine), sidecar running separately: toolbar pill on their real app; expand → real workbench overlay, entries render styled by their scss; agent chat + text tool + code panel work cross-origin through the sidecar; collapse → their app untouched. `pnpm check-types` (3 tsconfigs), tests, `pnpm --filter '@designbookapp/designbook' build` green; demo host mode boots identically.

### C3.2 — Sidecar mode + proxy front

Today `startDesignbook` (src/node/server.ts) always embeds the workbench Vite server. Add a **sidecar mode**: API + agent + figma bridge + worktrees, NO embedded UI vite — plus a **proxy front**:

1. `designbook dev` (CLI subcommand; keep bare `designbook` = host mode):
   - starts the API server (everything `api.handle` serves today) on the stable port (8787 logic unchanged);
   - spawns the target app's dev command (option/auto-detect from package.json `dev` script) — or attaches to an already-running one via `--target-url`;
   - **proxy**: non-`/api` requests on the stable port forward to the live target dev server (HTTP + WebSocket upgrade passthrough for their HMR). Same-origin bonus: through the proxy, `/api/*` needs no CORS.
   - **worktree switching**: `/api/worktrees` activation retargets the proxy to that worktree's dev server; the user's URL never changes.
2. **Recovery page**: target dev server unreachable → proxy serves a designbook-branded page with the error/last stderr and the Pi chat mounted (session is server-side, so the agent can fix the crash), auto-retry polling, reloads into their app when it comes back.
3. **`/__designbook` dev route** (served by the plugin inside their server AND by the proxy): renders their app with `autoExpand` + an optional deep-link payload (`/__designbook/component/<entryId>`) consumed by the boot module → expands overlay + navigates the memory router. Their URL space untouched otherwise.
4. `pnpm design` convention documented: `"design": "designbook dev"` — opens browser at the stable port with auto-expand on first run.

**Accept**: `designbook dev` against excalidraw — one URL; kill their dev server → recovery page with working Pi chat → restart → app returns; worktree create+switch via workbench keeps the same URL; their HMR websocket works through the proxy.

#### C3.2 implementation notes (landed)

- **Files**: `src/node/sidecar.ts` (target manager + proxy + recovery + `/__designbook`), `src/node/sidecarSupport.ts` (pure: `parseTargetPort`/`escapeHtml`/`recoveryPageHtml`/`deepLinkBootstrapHtml`, unit-tested), `src/cli/dev.ts` (the `dev` subcommand; `src/cli/index.ts` dispatches `argv[2] === "dev"`), plus `src/ui/navigationBus.ts` + `WorkbenchHandle.navigateTo` + a Workbench listener.
- **Deep link / `navigateTo`**: minimal plumbing via a window-event bus (`designbook:navigate`) that also stashes a pending target for the pre-mount case. It still drives the existing `navigate()` (which writes `location.hash`) — the router-mode switch that stops touching their URL is C3.4, as specced.
- **Worktree switching (the branch seam, fixed post-C3.2)**: the original C3.2 landing left `POST /api/worktrees` on the pre-proxy host-mode flow (spawn a designbook instance, UI navigates to `http://localhost:<port>` it assembled itself) — in proxy topology that sent the browser OFF the stable origin onto a raw instance port. Now `createApi` takes an optional `worktreeProxy` hook (`{ activeBranch, switchTo }`) that only the sidecar provides: `POST /api/worktrees` with the hook prepares the branch worktree via `prepareWorktree` (create + install + `designbook:setup`, per-branch log), retargets the proxied dev server into the worktree's app dir (`worktreeTargetCwd` maps the monorepo app package; switching back to the primary branch maps to the original cwd), and answers `{ branch, url: "/__designbook" }`. The response's `url` is the navigation contract: the UI navigates to it verbatim (appending its route hash only in hash-routing host mode) and NEVER builds `host:port` URLs (source-scan-guarded in `useWorktrees.test.ts`). Host mode (no hook) keeps the spawn-an-instance flow but the server now builds the url (`instanceNavigationUrl`, Host-header hostname). While the new dev server boots, the recovery page covers the stable origin. `GET /api/worktrees` with the hook reports the proxy's active branch as `currentBranch` and `running` = active (no per-branch port probing). `POST /api/target/retarget { branch }` routes through the same seam (so it installs too); `{ cwd }` stays a raw respawn (active branch then unknown).
- **Child lifecycle**: the target is spawned `shell: true, detached: true` and killed via process-group signal (`process.kill(-pid)`), so the real dev-server grandchild dies with the wrapping shell (a plain `child.kill()` orphaned Vite and leaked `--strictPort`). Restart-on-exit uses capped backoff; `retarget` clears the pending restart before respawning.
- **Recovery probe**: `/__designbook/ping` HEAD-probes the target root; the recovery page polls it every 2s and `location.reload()`s when it returns 200.

### C3.3 — HMR prevent / defer

1. **Prevent** (transplant): the `suppressedHmrPaths` mechanism + watch-ignores (`**/locales/**`, `**/*.po`) live in server.ts today; move them into a shared plugin used by BOTH the host-mode server and `designbookPlugin()`. Sidecar writes (text tool, theme, flags, po) must not reload their app: sidecar broadcasts written paths to the plugin (simplest: plugin polls `GET /api/recent-writes`, or a sidecar→plugin WS; builder's call — but it must work when sidecar and their server are separate processes).
2. **Defer**: with the overlay EXPANDED, intercept full reloads in the boot module (`import.meta.hot.on("vite:beforeFullReload", ...)` throws-to-cancel pattern) → queue it, show a "app updated — reload" pill on the workbench chrome; apply on collapse or explicit click. Component-level HMR updates flow through untouched (S1: cells hot-update with overlay open).

**Accept**: overlay open on excalidraw — text-tool save updates canvas without any reload; editing an excalidraw source file that triggers full reload while expanded → pill shown, no reload until collapse; the same edit while collapsed reloads normally.

### C3.4 — Reload rehydration

Full reloads still happen (defer pill, manual F5, dep re-optimize). Workbench must come back where it was.

1. **Memory router**: `useCanvasRoute` gets a mode switch — injected mode never reads/writes `location.hash`; route state lives in memory and mirrors to `sessionStorage` (host mode keeps hash behavior exactly). Key by project root so multiple apps don't collide.
2. **Durable selection addresses**: selection/drill state serialized as registry entryId + structural path (indexes into the fiber chain), not fiber refs — restore by replaying drill-in after the entry renders; silently drop if the component changed shape.
3. **Persist set** (sessionStorage, single versioned blob, write-through on change): expanded/collapsed, route (branch/flow/nodeIds), activeTab, tool, canvas transform per route, adapter selections (locale/theme/variant/dataset/flags), chat draft text, deferred-reload flag. Chat thread/model need nothing (server-side, replayed on `/api/events` reconnect — verified).
4. Boot module restores on load: if state says expanded → re-expand and rehydrate before first paint of the overlay (no flash of grid-home).

**Accept**: on excalidraw — expand, navigate to a component, drill into a child, zoom, type a chat draft, switch locale; hard-reload the page → overlay returns expanded on the same component with selection, zoom/pan, draft, and locale intact. Host mode: hash routing byte-identical to today; tests green.

## Order

C3.1 (serverUrl refactor first, then plugin) → C3.2 ∥ C3.3 → C3.4. Commit per stage.

## Watch-outs

- dist/ui is the artifact under test — run `pnpm --filter '@designbookapp/designbook' build:ui` after ui-source changes before exercising the plugin (stale-dist confusion cost time in C2).
- `vite-plugin-checker`-class plugins in THEIR config can break injection (S1 gotcha) — plugin must tolerate, doc the deny-list note; do NOT try to filter their plugins (their build is theirs).
- Proxy WebSocket passthrough must forward both their HMR socket AND not swallow `/api/figma-bridge` upgrades (ours stays on the API side).
- EventSource cross-origin: no custom headers possible — keep `/api/events` auth-free on localhost.
- StrictMode double-mount vs sessionStorage write-through (don't persist transient first-mount state).
- The 8811/8822/8833/8844 compat host-mode servers must still boot after each stage (spot-check one).
- Compat servers / demo use hash deep-links in docs & tests — only injected mode switches router modes.
