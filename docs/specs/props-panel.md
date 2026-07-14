# Props panel — typed schemas, editable controls, usage-site writes

Status: SHIPPED (branch `props-panel`, off `changesets-git`). The full-view
right panel's Props tab (src/ui/screens/fullView/) is now real, replacing the
prototype's mock inspector. Builds on the sandbox capture machinery
(docs/specs/sandbox.md), the source-owner ladder
(node/api/sandbox.ts `resolveOwnerSource`), and the changeset engine
(docs/specs/changesets-on-git.md).

## What it does

Selecting a component on the canvas renders its props IMMEDIATELY from the
live fiber's runtime values, then UPGRADES to typed controls once the schema
lands. Editing a control writes the JSX attribute at the SELECTED INSTANCE's
usage site, routed through the changeset engine.

## Schema endpoint

`GET /api/props-schema?file=<repo-rel>&export=<name>` →
`{ props: [{ name, typeText, kind, options?, required, defaultValue?,
description? }] }` or `{ unavailable: <reason> }`.

- `kind` ∈ `string | number | boolean | enum | node | function | object`.
- Extraction: `react-docgen-typescript` (src/node/api/propsSchema.ts). The
  typescript instance is resolved from react-docgen's OWN module location —
  its peer dependency, which in an installed app is the app's hoisted
  typescript — so the program we build and the checker docgen walks it with
  are one instance (mirrors the bake gate's app-local tsc rule). The app's
  `tsconfig.json` compiler options seed the program.
- Cache: one entry per absolute file, invalidated on mtime. First call pays
  the cold `createProgram` cost (seconds on big repos); the endpoint is async
  and independent, so it never blocks other routes.
- DEGRADED: when typescript / react-docgen / a tsconfig can't resolve, the
  response is `{ unavailable }` and the panel falls back to values-only.

## Controls (src/ui/screens/fullView/PropsInspector.tsx)

enum/union-literal → select · boolean → switch · string → input · number →
stepper · node/function/object → read-only value badges with a safe preview.
Unpassed optional props render greyed with their default. Row order + kinds
come from the schema; live/edited values fill them in
(src/ui/screens/fullView/propsRows.ts, pure + unit-tested).

## Usage-site writes

`POST /api/props-edit` sets / replaces / removes ONE JSX attribute at the
selection's `codeTarget` usage site (the same site the Code panel highlights).

- The edit is AST-located, text-applied (src/node/api/jsxAttrEdit.ts):
  `@babel/parser` gives every JSX element + attribute a precise span; the edit
  is one `magic-string` splice, so unrelated bytes are preserved. Add when
  unpassed, replace in place, remove on reset-to-default. Disambiguation
  mirrors `findUsageLine` (className → usage line → source order).
- SPREAD BAIL-OUT / no match / non-JSX site → `{ unresolvable }`: the panel
  shows the control read-only with a note. Writes are never guessed.
- ROUTING (mirrors the r2 manual-edit rule): active conversation →
  `sandbox.stageDirectCodeEdit` commits the edited file onto the
  conversation's direct-edits changeset trunk (`commitFileChange`, no
  worktree) + re-projects (previews via the layer engine), and records a
  sidecar turn so it shows in the timeline (label "Set <prop> on
  <Component>"). No active conversation → the real file, exactly like today's
  manual data edits. Rapid changes (typing / stepper) debounce into one write
  per settle (~320ms).

## Plugin sections

Plugins APPEND collapsible sections to the END of the panel (below the core
controls) — the same registration idiom as a left-rail tab or a
selection-context contribution: a plugin's ui half declares `propsSections`
on its `PluginUiSpec` (src/integration/index.ts), and `initUiIntegrations`
feeds each one into the section registry
(src/ui/models/propsPanel/sectionRegistry.ts), namespaced `<plugin>:<id>`. A
section's `Component` receives the resolved `PropsPanelSectionContext` — the
same file/export/schema/values the core controls use, decoupled from UI
internals. An empty registry renders nothing extra. Sections sort by `order`
then `id`. (Example future use: a "Push to Figma" section for the selected
component — a follow-up migration, not built here.)

## Tests

- `propsSchema.test.ts` — extraction (enum/optional/default/description,
  wrapped forwardRef+memo), mtime cache invalidation, degraded mode.
- `jsxAttrEdit.test.ts` — add/replace/remove precision, multiline openings,
  className/usage-line disambiguation, spread bail-out, string escaping.
- `propsEdit.test.ts` — conversation-mode trunk commit (real file untouched),
  no-op, spread bail-out.
- `propsRoutes.test.ts` — schema route + real-file write route (write, spread
  read-only, reset-remove, --read-only block).
- `propsRows.test.ts` — schema/runtime merge, kind inference, previews.
- `sectionRegistry.test.ts` — registration, replace, order/id sort,
  unregister/reset, empty-registry.
