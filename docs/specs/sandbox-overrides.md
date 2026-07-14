# Sandbox overrides — changesets, switches, in-place resolution

Status: SPEC FOR REVIEW (Michael + assistant, 2026-07-13). Implementation on a
dedicated branch after sign-off. Supersedes U5 overlay preview (killed at O1).
Builds on docs/specs/sandbox.md (v1–v3).

## Problem

1. Overlay preview renders outside the layout flow — sizing/context never
   faithful ("not in place, the sizing will never be right").
2. Multiple agents editing real source concurrently = write conflicts, and
   exploration mutates real files before anyone decided to keep anything.

## Core idea

Real source stays pristine during exploration. Designbook's vite plugin
redirects imports of a modified module to a GENERATED OVERRIDE SHIM that
switches between the original and sandbox variants at runtime. Preview = flip
a switch: the variant renders in the REAL tree — real parent layout, real
props, real providers, real interactivity. When the user commits, a BAKE step
writes the winner into real source through the existing gates and dissolves
the sandbox state.

## Model (three levels)

- **Changeset** — one exploration's whole body of work; 1:1 with a
  thread/pin. May span multiple module overrides + adapter-data additions.
  Unit of activate/deactivate (atomic) and of bake. Recorded in the sandbox
  index: `{id, threadPinId, overrides: [{module, exportName, variantFiles,
  base}], dataAdditions: [{adapter, file, keyPath}], active, baseHashes}`.
- **Switch** — per-component selection among what's available from ACTIVE
  changesets: `original | <changesetA variant> | <changesetB variant>`.
  Server-persisted (index), SSE-broadcast — all browsers agree; flipping is a
  React state change, no reload.
- **Instance prop** — escape hatch: `data-db-version="<variant>"` on a usage
  site pins THAT instance regardless of the switch (shim: prop > switch).
  For scenario pages / future changeset pages.
  [SUPERSEDED: the instance prop shipped with the shim engine and was
  DROPPED by changeset layers (docs/specs/changeset-layers.md) — a
  micro-shim can resurrect it later if changeset pages need it.]

## Resolution + shim

- Plugin `resolveId`: module with any override from an ACTIVE changeset →
  `.designbook/sandbox/overrides/<module>.tsx` (deterministic codegen, index-
  driven, NEVER model-authored). `?db-original` query bypasses (loop-proof).
- Shim: imports original + each active variant, renders per instance-prop >
  switch; `export *` passthrough for untouched exports; local named exports
  shadow star re-exports. First-time override of a module = one HMR
  invalidation of importers (hot update, never full reload).
- Dev-only, hard-gated: override resolution exists only under designbook dev;
  build/prod path proven untouched by test.

## Rules

- **Pins anchor to the COMPONENT** (module+export), not element instances.
  Element-level changes are expressed relative to the component's own JSX
  (element pins produce a full-module sandbox variant via the proven
  re-inline turn, targeted at the sandbox instead of real source). Preview
  shows at ALL instances — blast radius visible by design.
- **Prop/instance scoping is the conductor's judgment call**: the director
  decides from the USER'S PROMPT (not just captured props) whether the change
  is general or scoped to a specific prop/variant combination; scoped changes
  gate inside the variant code (`if (!props.compact) return <Original/>`),
  citing the distinguishing props of the selected instance.
- **ALL agent edits go through changesets** (Michael 2026-07-13, supersedes
  the earlier edits-follow-resolution rule for the real-source case): an edit
  turn targets the active variant file when a switch is on; when ORIGINAL is
  active, the edit creates (or extends) the pin's changeset as a single
  edit-variant — real source is written ONLY at bake. Single-variation asks
  ("give me 1 design variation") are changeset work too, never direct edits.
  Manual text-tool/adapter-data edits stay real-layer as before.
- **Stacking**: new work builds on the active resolution. Changeset B on top
  of A's variant records `base: A/<variant>`. Alternatives-from-original
  require flipping to original first. Deactivating a base flags dependents
  (drift warning; rebase = merge-agent).
- **Same-export conflict** (two independent active changesets touch one
  export): shim surfaces choose-or-compose. Compose = the ONLY merge-agent
  LLM step. Everything else is deterministic server code — registration,
  shim codegen, switch flips, bake queue.
- **Drift**: `baseHashes` captured at registration; real-file change under an
  override → warning on the changeset; rebase via merge-agent.

## Adapter data (single real layer)

- Variants may ADD adapter data (new i18n keys/msgids, new theme tokens) —
  written to the REAL files immediately; recorded as `dataAdditions` for GC on
  discard. Variants NEVER mutate existing keys/tokens (want different text →
  new key; changing a shared token = global edit, not variant work). Enforced
  centrally at the data endpoints (add-vs-mutate classified by the existing
  structured editors; sandbox-originated mutations rejected) + prompt rule.
- Flags/dataset: not writable from changesets.
- Manual text-tool edits keep writing the real layer (shared across
  original + variants), as today.
- No changes to how adapters are authored.

## Bake

- Unit = CHANGESET: all module writes land via the existing Replace machinery
  (tsc gate, navigation-preservation guardrail), serialized on a server queue;
  dataAdditions stay (already real); changeset dissolves; switches clear.
  Per-override bake = advanced option; bake-all-active = loop.
- Discard = delete changeset files + GC unused dataAdditions (reference-check
  before removal).

## UX

- Thread variant rows: "Preview in place" = switch flip (replaces U5 overlay,
  which is REMOVED — SandboxPagePreview/pagePreviewLive/locator machinery
  deleted at O1). Badge state on the page pill/tray while any changeset
  active ("sandbox active").
- Canvas: unchanged role — side-by-side gallery in captured state. FUTURE
  (noted, not in scope): changeset switcher/pages inside the canvas.
- Switch/changeset control: thread rows + tray; conflicts surface
  choose-or-compose inline (O3: conflict strip in the thread view — "N
  changesets modify X — choose or compose" — plus amber badges on thread
  rows and tray pills; `basedOnInactive` badge when a stacked base
  deactivates).
- Instance prop (`data-db-version`, O3 note): superseded by changeset
  layers (docs/specs/changeset-layers.md) — the prop rode the generated
  shim, which no longer exists. Kept here as history only.

## Build-environment portability

Designbook is Vite-only today (injection, HMR, /@fs previews, tailwind
@source) — overrides must not deepen that coupling. All override logic lives
OUTSIDE the plugin behind a minimal host seam:

    ModuleOverrideHost {
      redirect(map: realId -> shimPath)   // apply/refresh the redirect table
      originalBypassMarker                 // e.g. "?db-original" (host-specific)
      invalidate(moduleId)                 // importer invalidation on first override
      hotUpdate()                          // push the hot update, never full reload
    }

Vite implements this via resolveId (~a screen of code). Known equivalents:
webpack/rspack NormalModuleReplacementPlugin, esbuild onResolve; turbopack is
the weak spot (static resolveAlias only — loader approach if ever needed).
Shims are plain TSX files, the index is JSON, switch runtime is SSE + store,
bake writes ordinary source — all bundler-agnostic by construction. A future
bundler port implements the seam and inherits the feature. Enforced by a
layer-lint/seam test: nothing under the override modules imports vite types.

## Phases (dedicated branch)

- **O1**: changeset/switch index + resolveId + shim codegen + switch runtime
  (SSE) + thread "preview in place" + overlay preview removal. Component pins.
- **O2**: bake (queue, gates, dissolve) + discard/GC + drift detection.
- **O3**: element pins as full-module variants (`<pinId>/module/<variantId>.tsx`
  via the re-inline turn targeted at the sandbox); ALL agent edits through
  changesets (edits-follow-resolution when a switch is on; lazy edit-variant
  `<pinId>/edit.tsx` otherwise — single-variation asks route here too);
  stacking (`base` recorded, generation reads the active resolution) +
  same-export choose/compose (merge-agent; `bases` records both parents;
  `basedOnInactive` badge-only); instance prop verified.

## Beyond components — non-component modules & cross-module changesets (2026-07-13)

- The seam covers ANY client-graph ESM module; the SWITCH strategy differs:
  components = runtime switch in the shim (instant, O1); hooks/functions/data
  modules = STATIC shim (plain re-export of the chosen impl; flip = regenerate
  shim + one hot update — no rules-of-hooks hazard). Non-component overrides =
  future phase (post-O3), same index/changeset model.
- NEW code needs no override — new modules live in the pin dir and are
  imported by variants; only modifications to EXISTING shared modules shim.
- Cross-module changesets flip ATOMICALLY: all shims regenerate in one pass
  with one batched hot update — the app never renders mixed changeset state.
- Interface-ripple rule: conductor prefers backward-compatible shapes
  (additive fields); otherwise the changeset must grow to cover affected
  consumers. tsc at bake + error boundaries at preview catch stragglers.
- Out of reach by design: anything outside the vite client graph (app backend/
  API routes) — real edits or branch work.

## Future direction — relationship to branches/worktrees (noted 2026-07-13, NOT scheduled)

Changesets absorb the design-iteration case branch-switching served (parallel
isolated explorations, toggling states): one tree, no worktree/pool/proxy
churn, per-export conflict surfacing, write-isolated agents. Branches remain
for structural change (deps/config/renames/refactors/server code) and as the
collaboration substrate. Likely synthesis: BAKE-TO-BRANCH — a changeset bakes
onto a fresh git branch for PR review, demoting the per-branch dev-server
pool/proxy retarget/per-branch sessions to opt-in for structural work. Do not
dismantle branch machinery until changesets prove out through O3 + real use.

## Non-goals (v1)

Prod/build-time overrides, per-variant adapter-data overlays, flag/dataset
writes, changeset pages (future), multi-repo.
