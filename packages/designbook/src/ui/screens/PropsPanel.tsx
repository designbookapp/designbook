/**
 * The "props" tab (right-hand panel): read-only inspector for the current
 * canvas selection. A live component hit shows the instance's actual props
 * (read from its fiber via the previewHost seam); a DOM hit shows the
 * element's tag/id/classes; selections without a live fiber (flow screens,
 * "Go to component", reload-restored hits) degrade to source metadata.
 */

import { getFiberProps } from "@designbook-ui/previewHost";
import {
  summarizeProps,
  type PropRow,
} from "@designbook-ui/models/selection/propsSummary";
import { cn } from "@designbook-ui/lib/utils";
import type { CanvasNodeSelection } from "@designbook-ui/types";
import type { CanvasHitResult } from "./CanvasOverlay";
import { PanelSection } from "./panels";

const copy = {
  classesLabel: "class",
  emptyHint: "Select an element on the canvas to view its props.",
  exportLabel: "export",
  fileLabel: "file",
  idLabel: "id",
  noLiveProps: "Live props are unavailable for this selection.",
  noProps: "This instance received no props.",
  propsTitle: "Props",
  tagLabel: "tag",
};

/** A `name value` row, name in the muted column, value mono. */
function PropRowView({ row }: { row: PropRow }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0">
      <span className="shrink-0 font-mono text-xs">{row.name}</span>
      <span
        className={cn(
          "min-w-0 font-mono text-xs break-all",
          row.kind === "opaque" ? "text-muted-foreground" : "text-foreground/80",
        )}
      >
        {row.value}
      </span>
    </div>
  );
}

function PropsPanel({
  selectedHit,
  selectedNode,
}: {
  /** Live canvas hit (carries the fiber / DOM info when present). */
  selectedHit?: CanvasHitResult;
  selectedNode?: CanvasNodeSelection;
}) {
  if (!selectedNode) {
    return (
      <PanelSection title={copy.propsTitle}>
        <p className="text-xs text-muted-foreground">{copy.emptyHint}</p>
      </PanelSection>
    );
  }

  // DOM hit → element facts; component hit with a live fiber → real props.
  const domInfo = selectedHit?.dom;
  const rows: PropRow[] | undefined = domInfo
    ? [
        { name: copy.tagLabel, value: domInfo.tag, kind: "primitive" as const },
        ...(domInfo.id
          ? [{ name: copy.idLabel, value: domInfo.id, kind: "primitive" as const }]
          : []),
        ...(domInfo.classes && domInfo.classes.length > 0
          ? [
              {
                name: copy.classesLabel,
                value: domInfo.classes.join(" "),
                kind: "opaque" as const,
              },
            ]
          : []),
      ]
    : selectedHit?.fiber
      ? summarizeProps(getFiberProps(selectedHit.fiber))
      : undefined;

  return (
    <PanelSection title={copy.propsTitle} hint={selectedNode.description}>
      <div className="grid gap-2">
        <div className="grid gap-1 rounded-md border p-3">
          <span className="text-xs font-medium">{selectedNode.label}</span>
          {selectedNode.exportName ? (
            <p className="font-mono text-xs text-muted-foreground">
              {copy.exportLabel} {selectedNode.exportName}
            </p>
          ) : null}
          {selectedNode.path ? (
            <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {copy.fileLabel} {selectedNode.path}
            </p>
          ) : null}
        </div>
        {rows === undefined ? (
          <p className="text-xs text-muted-foreground">{copy.noLiveProps}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{copy.noProps}</p>
        ) : (
          <div className="grid rounded-md border px-3 py-1">
            {rows.map((row) => (
              <PropRowView key={row.name} row={row} />
            ))}
          </div>
        )}
      </div>
    </PanelSection>
  );
}

export { PropsPanel };
