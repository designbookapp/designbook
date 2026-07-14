# Figma as an integration plugin (spec + migration plan)

Status: in flight. Decisions below are SETTLED (Michael, decision sheet 2026-07-08) — do not re-litigate.

## Goal

Convert the hardcoded Figma integration into the first **integration plugin** behind a public
seam, so third-party tool integrations (Sketch, Penpot, device preview, …) can later ship as
external packages without core edits.

## Decisions

### A1 — Plugin API surface

One concept, two halves under one name:

```ts
type IntegrationPlugin = {
  name: string;                       // "figma"
  ui?: () => Promise<PluginUiSpec>;   // browser half (lazy)
  node?: PluginNodeSpec;              // server half
};

type PluginUiSpec = {
  tab?: {
    label: string;
    icon?: ComponentType;             // lucide icon component
    Screen: ComponentType<PluginScreenProps>;
  };
  /** Canvas serialize hook (the Figma push serializer). */
  serializeEntry?: (rootEl: Element, opts: SerializeEntryOptions) => Promise<unknown>;
};

type PluginScreenProps = {
  entry?: { id: string; label: string; sourcePath?: string }; // open canvas component
  apiUrl: (path: string) => string;
  openChat: (prompt?: string) => void; // drafts into chat; user's send = confirm gate
  tokenSources: TokenSource[];         // neutral theme-token registry (G2a)
};

type PluginNodeSpec = {
  routes?: PluginRoute[];             // { method, path, aliases?, write?, handler(req,res,url,ctx) }
  bridge?: { protocol: number };      // request a core device bridge (WS)
  piTools?: (ctx: IntegrationNodeCtx) => ToolDefinition[];
  skillsDir?: string;                 // absolute path, fed to piSkills additionalSkillPaths
  events?: (broadcast: (event: string, payload: unknown) => void, ctx: IntegrationNodeCtx) => void;
};

type IntegrationNodeCtx = { bridge?: DeviceBridge; log: (msg: string) => void };
```

Naming: the concept is **"integration"** (config key `integrations:`, export path
`@designbookapp/designbook/integration`) because `designbookPlugin()` is already the Vite plugin.

Because the node half and the browser half live in different bundles (tsc node program vs the
Vite UI build), the built-in figma plugin declares each half in its own entry module
(`src/plugins/figma/node/index.ts`, `src/plugins/figma/ui/index.ts`) under the same `name`.
Core merges by name. An external package would do the same via two export paths (S6).

`serializeEntry` is declared on `PluginUiSpec` and implemented by the figma plugin (wrapping the
moved serializer); today the only caller is the plugin's own tab. Core does not call it yet —
the hook exists so the canvas can offer serialization to plugins without a new API shape later.

### B1 — Bundle wiring

Package entries stay ui + node. The built-in figma plugin is registered via **static imports in
core**, at exactly two whitelisted registration sites:

- `src/node/integrations/builtins.ts` → imports `src/plugins/figma/node`
- `src/ui/integrations/builtins.ts`   → imports `src/plugins/figma/ui`

External-package auto-discovery via a package.json marker is **S6, post-launch** — the seam is
shaped for it (name-keyed registries, per-half entries) but it is NOT built now.

### C1 — Packaging + import-lint

Figma stays inside the designbook package but moves to `src/plugins/figma/`:

```
src/plugins/figma/
  shared/     figmaTokens, figmaHtml, figmaSlots, figmaRender, figmaComponentProps,
              figmaReadCss, figmaPullPrompt (pure mappers; compiled by BOTH programs)
  node/       routes, pi tools, bridge wiring, node entry
  ui/         FigmaPanel, FigmaSyncControls, serialize (ex figmaSerialize), ui entry
  skills/     figma-pull/SKILL.md
```

Enforced by a source-scan test (`src/integrationLint.test.ts` + `scripts/integration-lint.mjs`,
same house style as layer-lint):

1. Nothing outside `src/plugins/figma/` may import figma-specific modules (anything under
   `src/plugins/figma/`), EXCEPT the two builtins registration files above, which may import
   only the plugin's `node`/`ui` entry modules.
2. `src/plugins/figma/` may only import: its own files, the public seam
   (`@designbookapp/designbook/integration` types, `@designbook-ui/integration` UI seam,
   `src/node/integration/*` node seam helpers), the public config entry
   (`@designbookapp/designbook/config` — themeTokens/color stay core), the previewHost seam
   (`@designbook-ui/previewHost` — the sanctioned document-access surface), shared UI
   primitives (`@designbook-ui/components/**`, `@designbook-ui/lib/**`), and bare npm/node
   imports.

`figma-plugin/` (the Figma-side plugin app: code.ts/ui.ts/manifest) **stays top-level**.
Rationale: it is not part of designbook's runtime import graph (nothing imports it; it is
esbuild-bundled separately into `figma-plugin/dist` and loaded by Figma itself), so the
import-lint boundary doesn't apply, and moving it would churn build scripts, tsconfig and docs
for zero isolation gain. Documented as an explicit call.

### D1 — Registration UX

Built-in figma is **default-ON**. Opt out in the designbook config:

```ts
export default defineConfig({
  integrations: { figma: false },
});
```

`integrations?: Record<string, boolean | Record<string, unknown>>` — an object value is the
integration's options (see G2a). Third-party integrations later are always explicit. No churn
for existing configs.

Node-side caveat: the config file is a browser-bundled `.tsx` (import.meta.glob/JSX) that the
node server never evaluates. The node side honors the opt-out via a best-effort static scan of
the config source (`parseIntegrationToggles()` — recognizes the literal
`integrations: { … figma: false … }`). Documented limitation: a computed toggle disables the
UI half only. Acceptable: plugin routes are same-origin-gated anyway (E1).

### E1 — Security

- **No plugin-declared cross-origin exemptions.** Core owns a generic discovery route
  `GET /api/hello` → `{app, version, port}` with `ACAO:*` — the ONLY cross-origin-exempt path.
  `GET /api/figma-hello` stays as an alias (same handler, same headers) for the shipped Figma
  plugin. `isCrossOriginExemptApiPath()` matches exactly these two.
- **WS upgrades**: only core's device bridge accepts them, at `/api/bridge/<name>` (plus the
  sidecar's `/__designbook/api/bridge/<name>` form). `/api/figma-bridge` (and its namespaced
  form) stay as aliases for bridge `figma`. server.ts/sidecar.ts route upgrades dynamically via
  `api.handleBridgeUpgrade(pathname, …)` — no hardcoded figma paths.
- **Plugin routes** are same-origin-gated like every other `/api/*` route, namespaced
  `/api/x/<name>/…`. The shipped `/api/figma/*` paths remain as aliases to the same handlers
  (canonical + alias both dispatch through one table).
- Routes declaring `write: true` are added to the `--read-only` 403 block-set mechanically
  (union with the static core set in `readOnlyRoutes.ts`, canonical + alias paths). The figma
  routes are all `write: false`: they mutate the connected Figma file, never the repo —
  repo writes go through the core data endpoints, which are already blocked. (Unchanged
  behavior from before the seam.)

### F1 — Scope (launch already happened; this is S1–S5)

- **S1** internal registries: figma routes/tools/skills re-register through tables, files
  unmoved. Pure refactor, suite green.
- **S2** server seams: `/api/hello` (+ figma-hello alias), dynamic WS-upgrade routing in
  server.ts + sidecar.ts, write-flag → read-only set, figmaBridge promoted to core
  `createDeviceBridge(name)`.
- **S3** UI seam: plugin tab registry feeding the left rail, `PluginScreenProps`, neutral
  TokenSource registry + theme-adapter inversion (G2a).
- **S4** the move: all figma code → `src/plugins/figma/` importing only the public seam;
  import-lint red→green; skills contributed via `skillsDir`.
- **S5** publish the seam: `@designbookapp/designbook/integration` export + docs-site page
  marked EXPERIMENTAL.

One commit per stage, each stage green (typecheck + full vitest + build).

**S6 (external-package discovery) is explicitly punted.**

### G1a — Device bridge

`src/node/figma/figmaBridge.ts` is already tool-agnostic → promoted to
`src/node/bridge/deviceBridge.ts`, `createDeviceBridge(name)` (log prefix + generic error
copy parameterized by name). Core owns it; the figma plugin requests one via
`node.bridge: { protocol: 1 }` and receives it as `ctx.bridge`.

### G2a — Theme-token sync inversion

- The theme adapter publishes a neutral **TokenSource** into a core registry
  (`src/ui/integrations/tokenSources.ts`) instead of calling `setFigmaTokenSource()`:

```ts
type TokenSource = {
  id: string;                 // adapter name
  collectionHint?: string;    // display/default collection name
  modes: string[];
  getTokens(): TokenSourceToken[];   // resolved for the ACTIVE variant
  setToken?(mode: string, name: string, value: string): Promise<void>; // write-back
  meta?: Record<string, unknown>;    // opaque passthrough (deprecation shim)
};
type TokenSourceToken = {
  name: string; type: "color" | "dimension" | "number" | "string";
  valuesByMode: Record<string, string>;
  cssVar?: string; cssValue?: string; // for live probing / serializer attribution
};
```

- The figma plugin consumes the registry and hosts the variable-sync UI (Sync to / Sync from
  Figma buttons) on ITS tab. Token↔variable naming (nameRule/nameMapFile) and the target
  collection are **figma integration options**: `integrations: { figma: { tokens: {
  collection?, nameRule?, nameMapFile? } } }`.
- **Deprecation shim**: `themeAdapter({ figma: {...} })` still works — it logs a one-time
  deprecation warning and forwards the options through `TokenSource.meta.figma`; the figma
  plugin uses them when its own `tokens` options are absent. The one external client using
  `theme.figma` keeps working; migration note below.
- The Figma push serializer no longer reads `getFigmaTokenSource()` from adapterRuntime — the
  plugin passes the attribution map explicitly into `serializeEntry`.

## What moves / what stays

| Item | Disposition |
| --- | --- |
| src/config/figma{Tokens,Html,Slots,Render,ComponentProps,ReadCss,PullPrompt}.ts (+tests) | → `src/plugins/figma/shared/` (removed from the `/config` public export) |
| src/config/themeTokens.ts, src/config/color.ts | stay core (`/config`) |
| src/node/figma/figmaBridge.ts | → core `src/node/bridge/deviceBridge.ts` (G1a) |
| figma REST handlers + pi tools (api.ts) | → `src/plugins/figma/node/` |
| skills/figma-pull | → `src/plugins/figma/skills/figma-pull`, contributed via `skillsDir` |
| src/ui/screens/FigmaPanel.tsx, FigmaSyncControls.tsx | → `src/plugins/figma/ui/` |
| src/ui/previewHost/figmaSerialize.ts | → `src/plugins/figma/ui/serialize.ts` via `serializeEntry`; previewHost stops re-exporting it |
| figma-plugin/ (Figma-side app) | stays top-level (see C1 rationale) |

## Back-compat guarantees

- `/api/figma-hello` alias of `/api/hello` (both ACAO:*).
- `/api/figma-bridge` + `/__designbook/api/figma-bridge` alias `/api/bridge/figma` upgrades.
- `/api/figma/status|push|pull|html|variables` alias `/api/x/figma/...` (same handlers).
- `themeAdapter({ figma })` deprecation shim (warn + forward).
- Existing configs need no changes (figma default-ON).
- Removed without alias: `getFigmaTokenSource`/`setFigmaTokenSource` (internal UI module, never
  a public export) and the figma* symbols on `@designbookapp/designbook/config` (undocumented;
  internal to the plugin now).

## Migration notes (external client)

- No action needed at upgrade: `theme.figma` still works (logs a deprecation warning).
- Recommended move: delete `figma: {...}` from `themeAdapter(...)` and add
  `integrations: { figma: { tokens: { collection, nameRule, nameMapFile } } }` at the config
  top level.
- Sync to/from Figma buttons now live on the Figma tab (left rail), not the Theme tab.
- The Figma desktop plugin keeps connecting unchanged (hello + bridge aliases).

## Test plan

- Registry unit tests (route table dispatch, alias mapping, write-set union, bridge upgrade
  path matching, skills path contribution).
- Import-lint test (C1) — red before S4's move completes, green after.
- Alias-route guards: canonical + alias resolve to the same handler; exemption list is exactly
  {/api/hello, /api/figma-hello}.
- TokenSource inversion tests + deprecation-shim test.
- Updated guards: figmaChatHandoff (now pins the plugin-tab architecture), previewHostSeam
  (fibers stay sealed; serializer now plugin-side), readOnlyRoutes, apiOrigin exemptions.
- Demo app boots (port 8802) and `/api/hello` + `/api/figma-hello` answer.

## Full-view home (props-panel section)

The full-view migration deleted the left-rail integration TAB host (nothing
renders `getIntegrationTabs()` anymore), so the figma push/pull UI is rehosted
as a **props-panel section** — `FigmaSection` (src/plugins/figma/ui/), declared
on the plugin's `PluginUiSpec.propsSections` and namespaced `figma:sync` by the
section registry (docs/specs/props-panel.md §Plugin sections). It renders
collapsible below the core prop controls, only when the figma integration is
configured (empty registry otherwise).

The section reads the resolved `PropsPanelSectionContext`:

- `apiUrl` — polls `/api/x/figma/status` (5s) for the connection row.
- `live` (transient, non-serializable) — `{ entryId, root, fiber }` from the
  selected hit. Push serializes `root` (the live frame DOM anchor) with
  `entryFiber = fiber`: the full-view live app frame has NO `[data-db-entry]`
  wrapper ancestor, so the serializer boundary-walks from the supplied fiber
  instead of `getFiberFromDom(rootEl)` + a descendant lookup (serialize.ts).
- `openChat` — pull drafts the `formatPullPrompt` handoff straight into the
  live conversation's composer (the user's send click is the confirm gate; no
  auto-POST, no confirm panel — figmaChatHandoff.test.ts pins this).

Push is disabled (with a tooltip) when the bridge is disconnected OR the
selection has no live render (`serializable === false`, e.g. a DOM/restored
selection). A baseline row probes `.designbook/figma/<entryId>.json` through the
read-only `/api/file` route (404 → "no baseline yet"); last-push time is shown
when the baseline records a `pushedAt`.

The retired `FigmaPanel`/`FigmaSyncControls` + the `tab` spec remain in the tree
(dead until a host renders integration tabs again); they also hold the neutral
token-variable Sync buttons, which are not part of the section's scope.
