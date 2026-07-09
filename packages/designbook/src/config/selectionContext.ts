/**
 * Public selection-context contributor seam (PREVIEW — see
 * docs/specs/selection-context.md).
 *
 * A contributor derives facts about the current canvas selection. ONE registry
 * of contributions feeds TWO consumers rendering the SAME data: the Info panel
 * (human) and the chat prompt funnel (model). Contributions are derived per
 * selection and never persisted — repo files stay the only source of truth.
 *
 * These types are shared by both extension seams (`PluginUiSpec.selectionContext`
 * for integration plugins and `AdapterSetup.selectionContext` for adapters), so
 * they live here in the config entry, which both programs may import type-only.
 *
 * `facts` and `prompt` are DIFFERENT renderings: facts are labeled rows for
 * the panel; `prompt` is terse factual lines for the model. Never reuse one
 * string for both. Each contributor's prompt fragment is budget-capped by the
 * runner (~700 chars, truncated with a marker).
 *
 * Contributors must not subscribe to live stores (feedback-loop risk) —
 * snapshot state when called. They re-run on selection change and on manual
 * refresh; async contributors patch into the panel when they resolve.
 */

/** One labeled row in an Info panel section. */
type SelectionContextFact = {
  label: string;
  value: string;
  /** Render the value in a code (mono) style. */
  code?: boolean;
  /** Optional link target for the value. */
  href?: string;
};

/** One contributor's derived section for the current selection. */
type SelectionContextContribution = {
  /** Stable source id: "core" | "props" | "i18n" | … | <plugin name>. */
  source: string;
  /** Section heading in the Info panel. */
  title: string;
  /** What the panel renders. */
  facts: SelectionContextFact[];
  /** What the model gets — terse factual lines, SEPARATE from `facts`. */
  prompt?: string;
};

/**
 * Structural subset of the workbench's canvas selection handed to public
 * contributors (the internal `CanvasNodeSelection` satisfies it).
 */
type SelectionContextSelection = {
  label: string;
  description?: string;
  /** The component's export name, e.g. "ProductCard". */
  exportName?: string;
  /** Definition source path (projectRoot-relative). */
  path?: string;
};

/** Context handed to a contributor when it runs. */
type SelectionContextRunCtx = {
  /** Resolve an `/api/*` path against the designbook server origin. */
  apiUrl: (path: string) => string;
};

/**
 * Derives a contribution for a selection, or `undefined` to contribute
 * nothing. May be async (the panel patches the section in when it resolves;
 * prompt assembly at send time takes whatever has resolved).
 */
type SelectionContextContributor = (
  sel: SelectionContextSelection,
  ctx: SelectionContextRunCtx,
) =>
  | SelectionContextContribution
  | undefined
  | Promise<SelectionContextContribution | undefined>;

export type {
  SelectionContextContribution,
  SelectionContextContributor,
  SelectionContextFact,
  SelectionContextRunCtx,
  SelectionContextSelection,
};
