/**
 * Minimal edit popover for a plain string literal claimed by a source-literal
 * adapter. No placeholders or plurals — just an input that writes the new value
 * back through the claim's `save`.
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { TextClaim } from "@designbookapp/designbook/config";
import type { OverlayRect } from "./CanvasOverlay";

const copy = {
  cancelButton: "Cancel",
  saveButton: "Save",
  saveError: "Failed to save text",
};

type LiteralEditPopoverProps = {
  claim: TextClaim;
  anchorRect: OverlayRect;
  stageTransform: { x: number; y: number; scale: number };
  onClose: () => void;
  onSaveError?: (message: string) => void;
};

function LiteralEditPopover({
  claim,
  anchorRect,
  stageTransform,
  onClose,
  onSaveError,
}: LiteralEditPopoverProps) {
  const [value, setValue] = useState(claim.value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  async function save() {
    if (saving) return;
    const next = value.trim();
    if (!next || next === claim.value) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await claim.save(next);
      // Reflect the change on the canvas node (source-file adapters don't own
      // the render, so nudge the claimed text node directly).
      if (claim.node) claim.node.data = next;
    } catch (error) {
      onSaveError?.(error instanceof Error ? error.message : copy.saveError);
    }
    onClose();
  }

  function handleKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  const popoverLeft = anchorRect.x * stageTransform.scale + stageTransform.x;
  const popoverTop =
    (anchorRect.y + anchorRect.height) * stageTransform.scale +
    stageTransform.y +
    8;

  return (
    <div
      className="bg-popover absolute z-50 w-80 rounded-lg border p-3 shadow-lg"
      style={{ left: popoverLeft, top: popoverTop }}
      onKeyDown={handleKeyDown}
    >
      <div className="flex flex-col gap-2">
        <span className="truncate font-mono text-xs text-muted-foreground">
          {claim.editPath}
          {claim.line ? `:${claim.line}` : ""}
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="rounded border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex justify-end gap-2 border-t pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {copy.cancelButton}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {copy.saveButton}
          </button>
        </div>
      </div>
    </div>
  );
}

export { LiteralEditPopover };
export type { LiteralEditPopoverProps };
