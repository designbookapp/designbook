# Dogfooding designbook with designbook

`packages/designbook/designbook.config.tsx` is designbook's own workbench
config — it registers designbook's OWN components and data models as canvas
cells, so the workbench renders itself. This is the self-host target from the
R spec (`docs/specs/r-ui-reorg.md`, "Dogfood location" decision): the 7-model
re-org (`src/ui/models/{text,catalog,selection,branch,configState,frame,chat}`,
each a Provider + atoms + fixtures.ts) proves out here.

It doubles as the **component-library mode** showcase: a repo with no app of
its own — just a component library and some data models — can still get a
working workbench out of designbook by registering plain components +
fixture-fed model cells, no live runtime required.

## Run it

```sh
pnpm dogfood                                    # from the repo root — builds, then boots on :8842
# or, from packages/designbook, once built:
pnpm dogfood                                    # (package-local script)
node dist/cli/index.js designbook.config.tsx --port 8842 --no-open
```

Host mode only (no injected app to attach to). Uses port 8842, matching the
convention used for exploratory/self-host boots in this repo — the demo and
example apps' own ports (8787/8788/8790/3010/8811/8822/8833/8844) are
untouched by this config.

## What's registered

Three component sets, plus one flow:

- **`primitives`** (`Designbook/Primitives`) — 11 shadcn/ui primitives
  (Button, Badge, Card + subparts, Input, Label, Separator, Spinner, Avatar)
  from `src/ui/components/ui/`, registered directly (no wrapper). `Button`
  gets a `matrixAxes` override (variant × size), same as examples/demo's own
  primitives set.
- **`chrome`** (`Designbook/Workbench chrome`) — two PROMOTED PURE Workbench
  components from `src/ui/components/` (`SelectionToolbar`, `SideRail`), each
  wrapped in a tiny cell (`dogfood/ChromeCells.tsx`) that supplies
  representative sample props/state — these components take everything as
  props, so a cell is just "call it with plausible values."
- **`models`** (`Designbook/Models`) — one cell per data model
  (`dogfood/<Model>ModelCell.tsx`), each wrapping the model's real `Provider`
  in `data` (fixture) mode — fed by the model's own `fixtures.ts` — and
  rendering a handful of its `atoms`. All seven R-reorg models are covered:
  `text`, `catalog`, `selection`, `configState`, `branch`, `chat`, `frame`.
  This is the main proof: Provider + atoms + fixtures render in a canvas cell
  with **no live app, no adapter runtime, no design server** behind them.
- **`model-tour`** flow (`Designbook/Model tour`) — stitches three of the
  model cells (text, catalog, chat) into a flow, via `registryId` pointing at
  the entries the `models` set already registers.

Self-host is complete, not a fallback subset: every set/cell above boots
green and renders its real content (verified live, see below) — nothing is
stubbed or wireframed.

## The one real self-host wrinkle (read this before adding a model cell)

Every entry in the `models` set is registered as `lazy(() => import(...))`, a
dynamic import — **not** a static import at the top of
`designbook.config.tsx`. This isn't stylistic; two of the seven models
(`catalog`, `text`) will silently break the ENTIRE workbench's navigation if
imported statically from this file, and the fix generalizes to all of them so
the next model added here doesn't have to rediscover it.

**Why:** this config lives *inside* the package it configures. The dev
server's `main.tsx` does:

```ts
import { config, configDir } from "virtual:designbook-config";  // = this file
import { mountWorkbench } from "./mount";
...
mountWorkbench({ container, config, configDir });   // calls initConfigStore(config, ...) synchronously
```

`virtual:designbook-config` resolves to `designbook.config.tsx` itself, so
importing it means evaluating this file's *entire static import graph* —
**before** `mountWorkbench` has called `initConfigStore(config, ...)`, the
call that populates `@designbook-ui/designbook`'s live `sets`/`config`
bindings (used by every other model/screen module).

`componentRegistry.ts` computes its registry **eagerly, once, at module-eval
time**: `const registry = buildRegistry();` reads `sets` right then and
stores the result — a snapshot, not a live read. `catalog/flows.ts` and
`catalog/viewports.ts` do the same for `flows`/`viewportSizes`. If any of
those three modules gets evaluated as part of this config's own static import
graph, `sets` is still `[]` at that moment — and because ES modules are
singletons, that snapshot is now permanently empty for the rest of the page
session, for *every* consumer, not just the one that triggered it: the Files
panel's set trees, every flow screen, `PreviewCell`'s registry lookups —
the whole workbench.

Two models reach `componentRegistry.ts` as a plain **value** import (not
`import type`, which erases at compile time and is always safe):

- `catalog`'s `CatalogProvider.tsx` imports `registry` directly, plus
  `flows`/`viewportSizes` (its live-mode fallbacks).
- `text`'s `textModel.ts` imports `registryByName`/`registryByRef` directly
  (source-attribution for text claims), and separately pulls in
  `@designbook-ui/previewHost`, which itself re-exports catalog's registry
  lookups for fiber hit-testing (`previewHost/figmaSerialize.ts`).

`selection`, `configState`, `branch`, `chat`, and `frame` do **not** touch
the registry — verified by tracing every import in their Provider/atoms/
fixtures files down to either a pure algorithm module or a type-only import
(`import type`, erased). They'd be safe to import eagerly today. Every model
cell is registered via `lazy()` anyway, uniformly, so a future edit to one of
those five models that happens to add a `componentRegistry` import doesn't
silently reintroduce this bug in a file nobody thought to re-audit.

**The fix costs nothing extra**: `lazy()`'s dynamic `import()` only resolves
at first render (inside `PreviewCell`'s `React.lazy`/`Suspense`), which is
always well after `initConfigStore` has run. This is the same mechanism
`fromGlob` already uses for per-cell code-splitting + fault isolation — no
new machinery, just applied to this file's model cells by hand instead of a
glob (there's no directory of "model cell" files to glob over; each one
lives at `dogfood/<Model>ModelCell.tsx`).

**Confirmed empirically**, not just by reading the source: instrumenting both
`componentRegistry.ts`'s module body and `initConfigStore` with
`performance.now()` timestamps showed, on a cold load of this config with
`catalog`/`text` imported statically, `componentRegistry` evaluating ~4ms
*before* `initConfigStore` (`sets.length: 0` at that point) — versus
examples/demo's config (which lives outside this package, so its import graph
never reaches `componentRegistry.ts` before init) evaluating it ~600ms
*after* init, correctly, with the real `sets.length`. Pointing this same
dogfood server at examples/demo's config (temporarily, to isolate the repro)
confirmed the bug is specific to self-hosting, not a general regression. The
instrumentation was removed before landing; the finding is captured here
instead.

**If you add a model cell to this file**: register it via `lazy(() =>
import("./dogfood/YourModelCell"))`, not a static top-level import — even if
you've checked that today's version of that model doesn't touch the
registry. It's one extra `lazy()` call and it means nobody has to re-derive
this investigation.

## Verifying it

```sh
pnpm --filter '@designbookapp/designbook' test:run
pnpm --filter '@designbookapp/designbook' check-types
pnpm --filter '@designbookapp/designbook' build
pnpm --filter '@designbookapp/designbook' lint:layers
```

None of these gates touch `designbook.config.tsx` or `dogfood/` directly
(the config lives outside `src/ui`, so `lint:layers`'s scan and
`tsconfig.ui.json`'s `include` never reach it) — they just confirm the
dogfood config doesn't regress the product it's built from. The dogfood
files themselves were additionally typechecked ad hoc against
`tsconfig.ui.json`'s settings during development (clean) — see the git
history if you want to re-run that check; it isn't wired into a script since
the point of the exclusion above is that this file's failures shouldn't be
able to fail an unrelated consumer's build.

Then boot it live and click around (`pnpm dogfood`, or
`node dist/cli/index.js designbook.config.tsx --port 8842 --no-open` from
this directory) — every set/cell listed above should render real content,
not a red error-boundary cell or a blank wireframe placeholder.
