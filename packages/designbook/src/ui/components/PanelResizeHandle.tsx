/**
 * Vertical drag handle on a side panel's inner edge. Pointer-capture based
 * (same pattern as NodeDetailView's ResizablePreview): pointerdown captures,
 * moves feed the pure drag math (`panelResize.ts`), double-click resets to
 * the shared default. The owner is told when a drag is active so it can
 * guard the canvas (its iframes would otherwise swallow pointermove).
 */

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@designbook-ui/lib/utils";
import {
  PANEL_DEFAULT_WIDTH,
  dragPanelWidth,
  type PanelHandleEdge,
} from "@designbook-ui/panelResize";

const copy = {
  label: "Resize panel",
  title: "Drag to resize — double-click to reset",
};

function PanelResizeHandle({
  edge,
  onResizingChange,
  onWidthChange,
  width,
}: {
  /** Which edge of the panel this handle sits on (drag direction). */
  edge: PanelHandleEdge;
  /** Drag started/ended — the workbench disables canvas pointer events. */
  onResizingChange: (resizing: boolean) => void;
  onWidthChange: (width: number) => void;
  /** The panel's current width (drag baseline). */
  width: number;
}) {
  const dragRef = useRef<
    { pointerId: number; startClientX: number; startWidth: number } | undefined
  >(undefined);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: width,
    };
    onResizingChange(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onWidthChange(
      dragPanelWidth(drag.startWidth, drag.startClientX, event.clientX, edge),
    );
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizingChange(false);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={copy.label}
      title={copy.title}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={() => onWidthChange(PANEL_DEFAULT_WIDTH)}
      className={cn(
        // 6px strip straddling the panel border; invisible until hover/drag,
        // then tinted like ResizablePreview's handle (border → primary).
        "absolute inset-y-0 z-20 w-1.5 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-primary/50 active:bg-primary",
        edge === "right" ? "-right-[3px]" : "-left-[3px]",
      )}
    />
  );
}

export { PanelResizeHandle };
