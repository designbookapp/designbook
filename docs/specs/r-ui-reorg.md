# R spec — UI re-org: models pattern + self-design

_Decided with Michael 2026-07-07 (architecture artifact responses). Big-bang:
one re-org pass to the target tree, before the OSS sweep. Starts only after
P3 (tools-in-frames) merges — P3's worktree touches previewHost/AppPage and
must land first. P4 stays parked until after this._

## Decisions (settled, do not re-litigate)

- **Pattern**: every data model = Provider (loads live data; accepts `data`
  prop for tests/cells; optional `variant` prop selects a layout) + atoms
  (fields/actions/relationships) + layouts (arrangements, no data access) +
  co-located `fixtures.ts` (one canonical hardcoded dataset for tests, canvas
  cells, and example screens). Actions live on the provider context so atoms
  stay declarative and cells can stub them.
- **Dogfood location**: `packages/designbook/designbook.config.tsx` —
  self-host, no separate example app. Providers get fixture-fed cells
  (variant × dataset), pure components get plain cells, key screens become
  flows. Runs via host mode; the P1 frame guard already covers recursion.
- **Migration**: big-bang — one pass to the target tree. (Within the pass,
  sequence mechanical moves before behavioral unifications so the diff stays
  reviewable, but nothing ships in between.)
- **Ordering**: re-org → OSS sweep. P4 after both.
- **Names**: `text` (not textContent), `frame` (not appFrame).
- **Figma**: stays as `models/figma` for now but hard-isolated — nothing
  imports from it except its own screens' wiring; explicitly flagged as the
  candidate to move behind a future integration-plugin seam (it is an
  integration, not a data dimension — the adapter seam is wrong for it).

## Target tree

```
packages/designbook/src/
  node/
    plugin/        # designbookPlugin, boot module, frameGuard, pageTextTransform
    sidecar/       # sidecar, sidecarSupport, target manager, proxy
    api/           # api.ts handlers, recent-writes
    figma/         # figmaBridge, figmaBaselines
    config/        # configDiscovery, codegen (init)
    lib/           # shared node utils (cssVarEdit, …)
  ui/
    components/    # PURE — no data, no models, no adapters
    models/
      catalog/     # thin root: loads compiled config ONCE, owns HMR
                   #   resubscribe, exposes slices + navigate(address)
                   #   (addresses span entities) — absorbs componentRegistry
      set/ entry/  # per-entity models (Michael 2026-07-07): each with
      flow/ screen/#   provider (catalog slice OR direct `data`), atoms,
                   #   layouts, fixtures. Shared shapes via interfaces, not
                   #   inheritance: CanvasCitizen (id/title/status/cell —
                   #   entry+screen) and Collection<CanvasCitizen> (set+flow);
                   #   shared atoms (StatusBadge, NavTree) target interfaces
      selection/   # drill selection, code targets
      branch/      # branch, worktrees, file changes
      text/        # claims, locales, plural forms, markers — absorbs
                   #   i18nMarkers, textHits, pluralForms (fixes adapters→
                   #   Workbench layering violation)
      chat/        # Pi sessions, messages, streams
      figma/       # baselines, deltas, sync state (isolated; see Decisions)
      frame/       # App-page route + frame state (P1/P3)
      configState/ # flags, theme, datasets, hostContext
    screens/       # Workbench shell, CanvasStage, AppPage, PageToolsOverlay —
                   #   compose models; only layer allowed to import anything
    previewHost/   # seam stays (canvas/page/frame hosts)
    adapters/      # import models/, never screens/
    lib/
  designbook.config.tsx   # dogfood config + fixtures wiring
```

Import-lint (ESLint `no-restricted-imports`, cheap): `components/` imports
nothing above it; `models/` import components + lib; `adapters/` import
models, never screens; `screens/` import anything; nothing imports
`models/figma` except screens.

## Scope of the pass

1. **Mechanical moves first**: `node/` subfolders; split the 51-file
   `components/Workbench` into components/models/screens homes; fix imports;
   layer-lint rules land red→green in the same pass.
2. **Bus → actions**: `navigationBus` and ad-hoc `window.__designbook` UI
   wiring become provider actions (`catalog.navigate()`, `frame.open(path)`).
3. **Tool unification per model**: `TextToolOverlay` (canvas) +
   `PageTextTool` (page) + P3's frame text path become layouts/consumers of
   `models/text` — one claim-resolution pipeline, three surfaces. Same for
   selection surfaces over `models/selection`.
4. **Fixtures + dogfood config**: `fixtures.ts` per model; in-package
   `designbook.config.tsx` registering providers (variant × fixture cells),
   pure components, and 3–4 screens as flows (workbench-with-fixture-catalog,
   chat drawer open, App page with frame, Figma delta panel).
5. **Chrome tokens**: workbench chrome styles collapse into one token file
   while every component is being touched anyway.
6. **Public API audit**: `@designbookapp/designbook/config` + `@designbookapp/designbook/adapters` exports
   are the contract; everything else visibly internal. Decide
   `readFiberContext` export as part of this.

## Accept

- All existing gates green (unit suite, check-types, lib build) + layer-lint
  green.
- Injected mode e2e on the demo app: strip tools, expand → App page, P3
  frame tools — all behavior-identical pre/post re-org.
- Host mode e2e: demo config unchanged; PLUS the dogfood config boots
  (`designbook designbook.config.tsx` inside packages/designbook) showing
  model cells fed by fixtures and at least one screen flow.
- Adapters no longer import from screens/Workbench paths (lint-enforced).
- No public-surface change for existing users (config/adapters exports
  unchanged apart from the audited additions).

## Estimate

~1.0–1.4M tokens (mechanical moves are cheap; the tool-unification and
dogfood config are the real work). One builder agent, one reviewable pass;
main session reviews + commits.
