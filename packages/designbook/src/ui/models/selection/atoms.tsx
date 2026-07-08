/**
 * `selection` model atoms: the small, declarative pieces a screen or
 * a canvas cell composes over a resolved `CanvasNodeSelection`. Thin — the
 * selection model's real work is the drill/attribution/source-resolution
 * pipeline (selectionModel.ts) — so these exist only so a cell can render a
 * selection's label / target file / highlight line without reaching into a
 * screen, and so that rendering has ONE home.
 *
 * `useSelectionModel` (re-exported from SelectionProvider) is the context hook
 * the screens use to reach the pipeline.
 */

import type { CanvasNodeSelection } from "@designbook-ui/types";
import { useSelectionModel } from "./SelectionProvider";

/** A selection's Figma-style label (component label or `tag.class`). */
function SelectionLabel({ selection }: { selection: CanvasNodeSelection }) {
  return <>{selection.label}</>;
}

/** The file the code panel opens for a selection: the owner's file when drilled
 * (the selection carries a `codeTarget`), else the selection's own path. */
function TargetFile({ selection }: { selection: CanvasNodeSelection }) {
  return <>{selection.codeTarget?.file || selection.path}</>;
}

/** The 1-based highlight line for a selection within its (loaded) `source` —
 * usage line when drilled, definition line otherwise (see the model). */
function TargetLine({
  selection,
  source,
}: {
  selection: CanvasNodeSelection;
  source: string;
}) {
  return <>{useSelectionModel().targetLine(source, selection)}</>;
}

export { SelectionLabel, TargetFile, TargetLine, useSelectionModel };
