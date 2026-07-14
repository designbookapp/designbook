/**
 * Right panel: Props | Code tabs.
 *  - Props: the REAL props inspector (docs/specs/props-panel.md) — typed
 *    schemas via react-docgen-typescript over live runtime values, editable
 *    controls that write the JSX attribute at the selected instance's usage
 *    site through the changeset engine, plus plugin-contributed sections. Keeps
 *    the proto's dark editable-row visual design.
 *  - Code: the REAL CodePanel — the selected component's source (CodeMirror,
 *    definition/usage-line highlight, edit + save, diff mode via the Changes
 *    tab AND on-selection working-tree-vs-HEAD diff), dark-themed for the
 *    proto. When the selection's file is overridden by an ACTIVE changeset
 *    layer (client sandbox store), the panel points at the RESOLVED layer
 *    alternative: edits land in the layer (real file untouched) and the diff
 *    compares layer content vs the real file, labeled with the changeset.
 */

import { useMemo } from "react";
import { CodePanel } from "@designbook-ui/screens/panels";
import type { CodePanelLayerTarget } from "@designbook-ui/screens/CodePanel";
import type { CanvasNodeSelection } from "@designbook-ui/types";
import type { PropsPanelSectionContext } from "@designbook-ui/integrations";
import { useSandboxApi } from "@designbook-ui/models/sandbox/SandboxProvider";
import type { SandboxChangesetState } from "@designbook-ui/models/sandbox/sandboxModel";
import { PropsInspector } from "./PropsInspector";

/**
 * The ACTIVE changeset-layer override for `path`, resolved from the client
 * sandbox store: the topmost active layer wins (the store lists changesets
 * bottom→top, mirroring the server's redirect-table iteration), and an
 * override only redirects once it has a live selection. Returns the layer's
 * SELECTED alternative file (`variantFiles[i]` pairs with `alternatives[i]`
 * — alt ids are never derived from file names) + a display label.
 */
function resolveLayerTarget(
  changesets: readonly SandboxChangesetState[] | undefined,
  path: string | undefined,
): CodePanelLayerTarget | undefined {
  if (!path) return undefined;
  let target: CodePanelLayerTarget | undefined;
  for (const changeset of changesets ?? []) {
    if (!changeset.active) continue;
    for (const override of changeset.overrides) {
      if (override.module !== path || !override.selection) continue;
      const index = override.alternatives.indexOf(override.selection);
      const file = index >= 0 ? override.variantFiles[index] : undefined;
      if (file) {
        // Bottom→top iteration: later (topmost) layers overwrite.
        target = {
          file,
          label:
            changeset.title ??
            (changeset.direct ? "Direct edits" : changeset.id),
        };
      }
    }
  }
  return target;
}

function RightPanel({
  closed = false,
  width,
  tab,
  onTabChange,
  selection,
  runtimeProps,
  live,
  openChat,
  diffFile,
}: {
  closed?: boolean;
  /** Drag-resizable panel width (FullView owns + persists it). */
  width: number;
  tab: "props" | "code";
  onTabChange: (tab: "props" | "code") => void;
  /** Live frame selection — feeds the props inspector + real CodePanel. */
  selection?: CanvasNodeSelection;
  /** Live runtime prop values (fiber capture) for the props inspector. */
  runtimeProps?: Record<string, unknown>;
  /** Live selection handles for plugin sections (Figma push serialize). */
  live?: PropsPanelSectionContext["live"];
  /** Draft a prompt into the chat composer (Figma pull handoff). */
  openChat?: (draft: string) => void;
  /** Changes-tab diff override for the real CodePanel. */
  diffFile?: string;
}) {
  // The selection's ACTIVE layer override (topmost active changeset that
  // redirects this file) — the Code tab edits/diffs the RESOLVED target.
  const sandbox = useSandboxApi();
  const changesets = sandbox?.changesets;
  const selectionPath =
    selection?.codeTarget?.file || selection?.path || undefined;
  const layerTarget = useMemo(
    () => resolveLayerTarget(changesets, selectionPath),
    [changesets, selectionPath],
  );

  return (
    <div
      className={`dbproto-rightpanel ${closed ? "closed" : ""}`}
      style={closed ? undefined : { width }}
    >
      <div className="dbproto-panel-inner" style={{ width }}>
        <div className="dbproto-tabs">
          <button
            className={`dbproto-tab ${tab === "props" ? "active" : ""}`}
            onClick={() => onTabChange("props")}
          >
            Props
          </button>
          <button
            className={`dbproto-tab ${tab === "code" ? "active" : ""}`}
            onClick={() => onTabChange("code")}
          >
            Code
          </button>
        </div>
        {tab === "props" ? (
          <div className="dbproto-panel-scroll">
            <PropsInspector
              selection={selection}
              runtimeProps={runtimeProps}
              live={live}
              openChat={openChat}
            />
          </div>
        ) : (
          <div className="dark dbproto-embed fill">
            <CodePanel
              selectedNode={selection}
              diffFile={diffFile}
              appearance="dark"
              selectionDiff
              layer={layerTarget}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export { RightPanel };
