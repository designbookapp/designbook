/**
 * Minimal custom context menu for the select-tool canvas. Positioned at the
 * cursor, it offers a single "Go to component" action that opens the code tab
 * on the target's owning component definition. Dismisses on any outside
 * pointer-down or Escape.
 *
 * Dismissal details: the outside pointer-down listener runs in the capture
 * phase (so it beats the canvas overlay's own click handling), which means it
 * also runs BEFORE a click on the menu itself — it must ignore events whose
 * target is inside the menu, or the menu unmounts before its item's `click`
 * can ever fire. Escape is likewise handled in the capture phase and stopped,
 * so it closes the menu without also popping the workbench's drill stack.
 */

import { useEffect, useRef } from "react";

const copy = {
  goToComponent: "Go to component",
};

function CanvasContextMenu({
  x,
  y,
  onGoToComponent,
  onClose,
}: {
  x: number;
  y: number;
  onGoToComponent: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      // Pointer-downs inside the menu must not dismiss it — the menu item's
      // click only fires if the menu is still mounted on pointer-up.
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Consume the key so the workbench's Escape handler (drill pop /
        // deselect) doesn't also fire while the menu is open.
        event.stopImmediatePropagation();
        onClose();
      }
    }
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: x, top: y }}
      // Keep every pointer/mouse event inside the menu away from the canvas
      // overlay's own handlers (select / drill / context menu).
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        className="flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-xs outline-none hover:bg-accent hover:text-accent-foreground"
        onClick={() => {
          onGoToComponent();
          onClose();
        }}
      >
        {copy.goToComponent}
      </button>
    </div>
  );
}

export { CanvasContextMenu };
