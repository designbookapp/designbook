# Config slim — auto export index replaces registry config

Status: shipped on `config-slim` (next release after 0.5.0). Breaking-with-warning.

## Target config shape

```tsx
export default defineConfig({
  title: "My app",        // optional (browser tab / chrome)
  adapters: [...],        // theme/flags/i18n adapters
  // i18n / themes / viewports / hostContext / pageText / integrations unchanged
});
```

Everything registry-shaped is DERIVED, not configured; previews run in the
LIVE app, which brings its own providers and data.

## Removed (deprecate → warn → no-op next release)

- `sets` (components maps, `wrapper`, `overrides`/`matrixAxes`/`editableProps`/
  `previewWidth`, set titles)
- `flows`
- `sourceModules`
- `providers` — zero consumers left (the component canvas is retired; adapter
  Providers come from each adapter's `setup().Provider`, verified in
  `adapterRuntime.ts`)
- `datasets` — zero consumers left (only fed a ConfigStateProvider field
  nothing reads). `useDataset()`/`DatasetContext` REMAIN supported as an
  app-side API: the app provides the context itself (demo `App.tsx`)
- `fromGlob` helper

This release they still WORK; the workbench warns loudly once (console with
migration detail + a one-time dismissible UI notice, `DeprecationNotice.tsx`).
They must never crash — client repos still pass them.

## The auto export index

Mechanism:

- The vite plugin (`node/plugin/exportIndex.ts`, wired in `plugin.ts`) scans
  every CLIENT-GRAPH module in its `transform` hook (post-order — lowered ESM
  keeps all `export` forms textual): `export function/const/class X`,
  `export { X, y as Z }`, `export default` (named, identifier, or anonymous →
  PascalCased filename). Names must look like components (leading capital, not
  SCREAMING_CASE). Excluded: node_modules, virtual ids, `.designbook/`, the
  designbook package, the config file.
- Incremental: the index grows lazily as vite transforms modules and updates
  on re-transform; full snapshot is pushed (debounced 500ms + 15s heal-push)
  to the sidecar: `POST /api/export-index`. The sidecar store
  (`node/api/exportIndexStore.ts`) is memory-only; restart self-heals.
- Workbench: `GET /api/export-index` (3s version-gated poll,
  `startExportIndexSync` in `componentRegistry.ts`) synthesizes name-keyed
  registry entries (`origin: "index"`, id `src:<file>#<name>`) into
  `registryByName`. `matchFiber`'s by-name fallback then makes every in-repo
  exported component a hit-test/drill boundary — labels are the fiber
  component names. `registryByRef` stays sets-only.
- Node: the export-scan ladder (`makeExportResolver` in `node/api/sandbox.ts`)
  became hint file → INDEX LOOKUP (verified against the real source, so a
  stale index can't misattribute) → bounded directory scan fallback. Pins on
  not-yet-loaded pages still resolve via the scan.

Ambiguity: a name exported from several files keeps the sorted candidate list
(`sourceCandidates`), displays the first, logs once; node-side resolution
re-verifies per pin/edit (owner-chain proximity ordering is preserved by the
ladder's candidate order).

Page shells: with everything indexed, App/page/providers would become the
"outermost registered component" for every click. `trimPageSizedTail`
(`previewHost/fibers.ts`) pops index-origin chain tails that read as shells:
name matches the scaffolding conventions (`App`/`Root` exact, or a
`Page`/`Layout`/`Shell`/`Screen`/`Provider(s)`/`Router`/`Routes` suffix) AND
spans ≥60% of the body height, OR any name covering ≥97% of the body in both
dimensions (the App/provider signature; pure geometry can't catch centered
`max-width` page containers, hence the name rule). At least one component
level is always kept; sets entries are never trimmed; trimmed shells remain
reachable via the raw-DOM source-owner fallback.

Assumptions/limits (documented): dev-only (React prod builds lose component
names — unchanged); anonymous/minified components are not selectable (as
before); a node_modules component sharing a name with an in-repo export
matches by name (same risk the old lazy-name registration had); a renamed
file leaves a stale index entry until re-transform (node-side verification
covers misresolution).

## Consumers migrated

`appFrameHit` / `resolvePageHit` / `CanvasOverlay` / `captureLive` /
`selectionContext/contributors` / `textModel` / figma `serialize` all consume
`registryByRef`/`registryByName` through `matchFiber` — unchanged code paths,
now fed by the index. Capture (`captureFromHit`) works with synthetic
`entryId`s (pins are entry-less-capable already).
