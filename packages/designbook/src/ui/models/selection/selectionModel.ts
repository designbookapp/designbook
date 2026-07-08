/**
 * The `selection` model — Figma-style drill-in selection + code-target
 * attribution + code-panel source resolution.
 *
 * Selecting on the canvas is a pipeline of PURE operations over the interleaved
 * hit-test chain under the pointer: resolve what a click/double-click/deep-click
 * selects (drillSelection.ts), attribute each level to its owner's JSX site
 * (codeTargets.ts), and locate the definition/usage line + editor language in
 * the owner's source (findDefinitionLine/findUsageLine/languageForPath). This
 * model is the ONE home that bundles those operations so screens (the code
 * panel, the canvas overlays) consume them declaratively through context.
 *
 * ## Variance seam (Michael 2026-07-07, decision 1)
 * The selection model has NO per-surface decorator (unlike the text model's
 * `decorateSave`). Its operations are identical pure functions in every mode —
 * live and fixture differ ONLY in the chain/selection *data* fed to them. So the
 * factory takes just an optional `data` (a canonical resolved selection for
 * atoms/cells to render); the live selection *state* (`selectedHit`,
 * `drillStack`) stays where it is managed (Workbench React state), transitioned
 * BY these operations. Shoehorning a decorator here would not fit the data.
 *
 * The imperative canvas overlays still reach the drill/attribution functions
 * through the `previewHost` seam (which re-exports them from here); this model
 * is the declarative path for everything else.
 */

import type { CanvasNodeSelection } from "@designbook-ui/types";
import {
  drillableIndices,
  resolveClickSelection,
  resolveDeepClick,
  resolveDoubleClick,
  resolveEscape,
} from "./drillSelection";
import { resolveCodeTargets, resolveLevelOwner } from "./codeTargets";
import { findDefinitionLine } from "./findDefinitionLine";
import { findUsageLine } from "./findUsageLine";
import { languageForPath } from "./languageForPath";

/** Canonical selection data fed via the provider's `data` prop (atoms/cells). */
type SelectionData = {
  /** A resolved selection for atoms to render (label/target file/line). */
  selection?: CanvasNodeSelection;
};

/** The selection model surface exposed on context and returned by the factory. */
type SelectionModel = {
  /** The canonical selection in fixture/cell mode; undefined in live use. */
  selection?: CanvasNodeSelection;
  // Drill-in resolution over the interleaved chain (see drillSelection.ts).
  drillableIndices: typeof drillableIndices;
  resolveClick: typeof resolveClickSelection;
  resolveDoubleClick: typeof resolveDoubleClick;
  resolveDeepClick: typeof resolveDeepClick;
  resolveEscape: typeof resolveEscape;
  // Owner-attributed code targets (see codeTargets.ts).
  resolveCodeTargets: typeof resolveCodeTargets;
  resolveLevelOwner: typeof resolveLevelOwner;
  // Source resolution for the code panel.
  definitionLine: typeof findDefinitionLine;
  usageLine: typeof findUsageLine;
  languageFor: typeof languageForPath;
  /**
   * The 1-based line to highlight for a selection in its (already-loaded)
   * `source`: the owner's usage line for a drilled selection (it carries a
   * `codeTarget`), else the selection's own definition line. Mirrors the code
   * panel's `targetLine` derivation exactly.
   */
  targetLine: (source: string, selection: CanvasNodeSelection) => number;
};

type CreateSelectionModelOptions = {
  /** Canonical selection for atoms/cells; omitted in live pointer-driven use. */
  data?: SelectionData;
};

function targetLine(source: string, selection: CanvasNodeSelection): number {
  const ct = selection.codeTarget;
  if (ct?.ownerExportName && ct.name) {
    return findUsageLine(source, ct.ownerExportName, ct.name, ct.className);
  }
  return findDefinitionLine(source, selection.exportName);
}

/**
 * Build a selection model. Pure — no React, no globals. The operations are the
 * same in every mode; `data` only carries a canonical selection for atoms.
 */
function createSelectionModel(
  options: CreateSelectionModelOptions = {},
): SelectionModel {
  return {
    selection: options.data?.selection,
    drillableIndices,
    resolveClick: resolveClickSelection,
    resolveDoubleClick,
    resolveDeepClick,
    resolveEscape,
    resolveCodeTargets,
    resolveLevelOwner,
    definitionLine: findDefinitionLine,
    usageLine: findUsageLine,
    languageFor: languageForPath,
    targetLine,
  };
}

export { createSelectionModel };
export type {
  CreateSelectionModelOptions,
  SelectionData,
  SelectionModel,
};
