# Selection context (Info panel + prompt funnel) — PREVIEW

STATUS: PREVIEW feature, settled in conversation with Michael (2026-07-09).
This spec records the shape; it is not a proposal. Concerns go in
"Open questions", not into re-litigating the design.

## Concept

ONE registry of selection-context contributors; TWO consumers render the SAME
contributions:

- the **Info panel** (right-hand panel, first tab) — for the human;
- the **chat prompt funnel** (`buildPromptWithCanvasContext`) — for the model.

Repo files stay the only source of truth. Contributions are DERIVED, computed
per selection, never persisted anywhere.

## Types

```ts
type SelectionFact = { label: string; value: string; code?: boolean; href?: string };

type SelectionContextContribution = {
  source: string;            // "core" | "props" | "i18n" | "theme" | <plugin name>
  title: string;             // section heading in the Info panel
  facts: SelectionFact[];    // what the panel renders
  prompt?: string;           // what the model gets — SEPARATE from facts, terse factual lines
};

type SelectionContextContributor = (
  sel: CanvasNodeSelection,
  ctx: { apiUrl: (p: string) => string }
) => SelectionContextContribution | undefined
   | Promise<SelectionContextContribution | undefined>;
```

Internally the runner hands contributors a richer input than the public
signature: the `CanvasNodeSelection` plus a **live handle** snapshot
(`entryId`, `instanceId`, the live fiber/anchor from the canvas hit, and the
changed-files list captured at run time). Public contributors (integration
plugins, adapters) get only `(sel, { apiUrl })` — the seam stays exactly the
settled shape; the live handle is internal because fiber access must go
through the previewHost seam anyway.

## Rules (settled)

- **facts vs prompt** are different renderings of the same derivation — never
  one string reused for both.
- **Sync-first, async-refresh**: synchronous contributions render immediately;
  async ones patch into the panel when they resolve. Prompt assembly at send
  time takes whatever has resolved by then. Contributors re-run on selection
  change; a manual refresh re-runs them for the current selection.
- Contributors must NOT subscribe to live stores (feedback-loop risk) — they
  snapshot state at run time.
- **Per-contributor prompt budget**: each contributor's prompt fragment is
  capped (~700 chars) and truncated with a visible `[truncated]` marker.
- **Sampled serialization** for values: depth/size-capped, functions listed by
  name only, cycles cut. Dev-mode-only assumptions are fine (designbook never
  runs in prod builds).
- **Visibility**: the chat's selected-node marker is expandable to show the
  FULL assembled context that will be sent — the send click stays an informed
  confirm gate.
- **Order**: deterministic — core first, then registration order. Built-ins
  register at mount (core, props, render context, i18n, context scope), then
  integration/adapter contributors in their init order.

## Pieces

### Registry (`src/ui/models/selectionContext/`)

House registry pattern (like `integrations/tokenSources.ts`): module-level map
+ `register`/`unregister` + `snapshot`/`subscribe` for `useSyncExternalStore`.
A separate **run store** owns the per-selection lifecycle: `run(input, ctx)`
(called by the Workbench on selection change), `refresh()`, `getSnapshot()`
(ordered resolved contributions + pending count), and
`getPromptFragments()` (capped, core first) for the funnel.

### Info panel (replaces Props)

Right-panel tabs become **Info, Chat, Code** (Info first). Persisted
`rightTab: "props"` migrates to `"info"` in `workbenchTabs.resolveInitialTabs`
so nobody lands on a dead tab. The panel renders one collapsible section per
contribution (source-titled), async sections appearing as they resolve, plus a
manual refresh; empty state when nothing is selected. The old PropsPanel
fiber-props view becomes the `props` contributor's section.

### Built-in contributors

- **core** — entry id, label, definition path + exportName, instance id; when
  drilled (`codeTarget`) also the usage site (owner file, element name,
  className). Git status badges for the involved file(s) come from the changes
  model snapshot (no re-fetch). Prompt fragment states BOTH sides for a
  drilled instance: "instance X used inside Owner at owner-file" AND
  "component defined at path" (this fixes the drilled-instance prompt bug).
- **props** — live fiber props via the previewHost seam through the sampled
  serializer; DOM hits show tag/id/classes. Prompt = compact `name: value`
  lines.
- **render context** — the adapter runtime's dimension snapshot
  (locale/variant/mode/flags + custom dimensions), taken at run time.
- **i18n** — two enumerations with provenance:
  - RUNTIME: walk the selected fiber subtree's host elements collecting the
    text tool's invisible i18n markers → keys rendered right now with their
    current-locale values (reuses the marker machinery via previewHost).
    Rendered text nodes WITHOUT markers are counted as "N hardcoded strings".
  - STATIC: `GET /api/file` on the component source (and `codeTarget.file`
    when drilled), scanned for i18next call shapes — `t("…")`, `t('…')`,
    `` t(`…`) ``, `<Trans i18nKey="…"`. Template keys with `${…}` are flagged
    dynamic (non-enumerable).
  - Merged with provenance flags: rendered / declared-only / dynamic.
- **context scope** — fiber walk UP from the selection: every ancestor context
  provider with context displayName, the provider's owner component + source
  file where attributable, and the live `memoizedProps.value` through the
  sampled serializer. Marks which contexts the selected component CONSUMES
  (its `fiber.dependencies` chain) and marks farther same-context providers as
  shadowed. No library unwrappers (zustand/tanstack) in this unit. The walker
  lives in `src/ui/previewHost/` (same-document fiber access); everything else
  consumes it only through the seam.
- **figma** — dogfoods the plugin seam, kept tiny: connection status +
  push/pull availability via the integration's status route.

### Seam extensions (additive)

- `PluginUiSpec.selectionContext?: SelectionContextContributor` — integration
  plugins contribute a section (registered by `initUiIntegrations`).
- `AdapterSetup.selectionContext?: SelectionContextContributor` — adapters get
  the same hook (registered by the adapter runtime at init).
- The public contributor types live in `@designbookapp/designbook/config`
  (`selectionContext.ts`) with a structural `SelectionContextSelection`
  subset, so both seams share one shape and neither program imports UI types.

### Prompt funnel

`buildPromptWithCanvasContext(message, selectedNode, contextBlock?)` — when
the run store has resolved fragments, the assembled block (core first) IS the
context; the legacy per-field lines remain only as a fallback when the store
is empty, and that fallback also states both the usage site and the definition
for a drilled selection. The DesignChat footer marker shows the same assembled
context, expandable before send.

## Testing

Node-env, pure-logic seams (house style): registry order / async patch-in /
prompt caps; the sampled serializer; the i18n static scanner (call shapes,
dynamic-key flagging); prompt assembly incl. the codeTarget case; the
persisted-tab migration; previewHost seam guard extended to the selection
context modules (they must reach fibers only via the seam).

## Not in scope (follow-ons)

- docs-site pages (this is a preview feature);
- library unwrapper plugins (zustand/tanstack context values stay sampled raw);
- the "Trace data" agent action;
- click-to-edit on i18n facts (display-only for now);
- Figma pushed-state via live bridge queries (status route only).

## Open questions

- Internal run input carries a live fiber handle the public signature hides —
  OK, or should the public seam eventually expose a read-only facts API?
- Per-contributor 700-char cap is uniform; props/context-scope may deserve
  their own budgets once real usage shows skew.
- Context-scope consumption is read off the selected fiber's own
  `dependencies` chain only (not its subtree) — good enough for preview?
- The i18n static scanner is regex-based (no AST); fine for preview, revisit
  if false positives show up in client repos.
- The context-scope walk continues past the preview cell into workbench
  chrome (CanvasStage / frame providers show up after the user's providers,
  demo-verified). Honest — they ARE in scope — but a preview-boundary marker
  that stops the walk (or tags chrome providers) is a likely refinement; the
  nearest-first order plus the prompt budget keeps user providers ahead of
  the noise meanwhile.
