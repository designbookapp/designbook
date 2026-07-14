/**
 * Select tool over the App page's frame cell — the canvas's own
 * `CanvasOverlay` driven through the iframe instead of the same-document tree.
 *
 * `CanvasOverlay` already implements hover/click/drill/"Go to component" purely
 * in terms of a pluggable `elementAtPoint`/`rectToScreen` pair; this component
 * supplies the frame-aware versions (via the `previewHost` seam's
 * `elementAtFramePoint`/`frameLocalRectToScreenRect`) and adds the one thing
 * page mode has that canvas mode doesn't: a floating selection chip (registry
 * label, Prompt Pi, Go to component) anchored at the selection, matching M1's
 * page-tools affordances.
 */

import { useFrameModel } from "@designbook-ui/models/frame/FrameProvider";
import { useStageTransform } from "./stageContext";
import {
  elementAtFramePoint,
  frameLocalRectToScreenRect,
} from "@designbook-ui/previewHost";
import { CanvasOverlay, canvasHitLabel, type CanvasHitResult } from "./CanvasOverlay";
import {
  canGoToFrameComponent,
  canPromptFrameSandbox,
} from "@designbook-ui/models/frame/appFrameHit";
import { SandboxPromptBox } from "./sandbox/SandboxPromptBox";
import { SandboxPinBubbles } from "./sandbox/SandboxPins";
import { frameHitToSandboxSelection } from "./sandbox/promptTarget";
import { useCatalogModel } from "@designbook-ui/models/catalog/CatalogProvider";

const copy = {
  promptPi: "Prompt Pi",
  goToComponent: "Go to component",
  dismiss: "Dismiss",
};

function SelectionChip({
  hit,
  stageTransform,
  onPromptPi,
  onGoToComponent,
  onDismiss,
}: {
  hit: CanvasHitResult;
  stageTransform: { x: number; y: number; scale: number };
  onPromptPi: () => void;
  onGoToComponent: () => void;
  onDismiss: () => void;
}) {
  const left = hit.rect.x * stageTransform.scale + stageTransform.x;
  const top =
    (hit.rect.y + hit.rect.height) * stageTransform.scale +
    stageTransform.y +
    8;

  return (
    <div
      className="pointer-events-auto absolute z-50 flex items-center gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="max-w-40 truncate px-1.5 text-xs font-medium">
        {canvasHitLabel(hit)}
      </span>
      <button
        type="button"
        className="cursor-default rounded-sm px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
        onClick={onPromptPi}
      >
        {copy.promptPi}
      </button>
      {canGoToFrameComponent(hit) ? (
        <button
          type="button"
          className="cursor-default rounded-sm px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
          onClick={onGoToComponent}
        >
          {copy.goToComponent}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={copy.dismiss}
        className="cursor-default rounded-sm p-1 hover:bg-accent hover:text-accent-foreground"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

function AppFrameOverlay({
  drillStack,
  onDrillChange,
  onGoToComponent,
  onSelect,
  selectedHit,
  onPromptPi,
  pillOnly,
}: {
  drillStack: CanvasHitResult[];
  onDrillChange: (stack: CanvasHitResult[]) => void;
  onGoToComponent: (hit: CanvasHitResult) => void;
  onSelect: (hit: CanvasHitResult | undefined) => void;
  selectedHit: CanvasHitResult | undefined;
  /** Open the chat tab prefilled for this hit (the App-page counterpart of
   * page mode's docked Pi drawer — the full canvas UI has no floating drawer,
   * it has the sidebar chat tab). */
  onPromptPi: (hit: CanvasHitResult) => void;
  /**
   * Proto full-view mode: keep ONLY the selection outline + its dark name
   * pill (CanvasOverlay's own label). Every other selection-attached chrome —
   * the action chip, the sandbox prompt pop-up, the pin bubbles — is dropped;
   * prompting happens in the full-view chat panel instead. Default (unset)
   * keeps the normal App-page surface untouched.
   */
  pillOnly?: boolean;
}) {
  const { iframe } = useFrameModel();
  const stageTransform = useStageTransform();
  const { navigateSandbox } = useCatalogModel();

  if (!iframe) return null;

  return (
    <>
      <CanvasOverlay
        drillStack={drillStack}
        onDrillChange={onDrillChange}
        onGoToComponent={onGoToComponent}
        onHover={() => {}}
        onSelect={onSelect}
        selectedHit={selectedHit}
        elementAtPoint={(clientX, clientY) =>
          elementAtFramePoint(iframe, clientX, clientY)
        }
        rectToScreen={(rect) => frameLocalRectToScreenRect(iframe, rect)}
        // Everything under the pointer here is the USER'S app — DOM outside
        // registered components resolves its unregistered authoring component
        // (page shells) so element pins work anywhere (sandbox owner fallback).
        sourceOwnerFallback
      />
      {selectedHit && !pillOnly ? (
        <SelectionChip
          hit={selectedHit}
          stageTransform={stageTransform}
          onPromptPi={() => onPromptPi(selectedHit)}
          onGoToComponent={() => onGoToComponent(selectedHit)}
          onDismiss={() => onSelect(undefined)}
        />
      ) : null}
      {/* Sandbox prompt box (docs/specs/sandbox.md, D1 — ADDITIVE below the
          chip; nothing existing moves) + the per-pin comment bubbles. A
          drilled DOM element shows the box too (v2): it creates an ELEMENT
          pin against the owner (`entry` IS the owner for a DOM hit) — and so
          does a DOM element with an UNREGISTERED source-resolved owner (page
          shells; ownerKind "source", canPromptFrameSandbox). */}
      {selectedHit && !pillOnly && canPromptFrameSandbox(selectedHit) ? (
        <SandboxPromptBox
          selection={frameHitToSandboxSelection(selectedHit)}
          position={{
            left: selectedHit.rect.x * stageTransform.scale + stageTransform.x,
            top:
              (selectedHit.rect.y + selectedHit.rect.height) *
                stageTransform.scale +
              stageTransform.y +
              46,
            mode: "absolute",
          }}
          onOpenCanvas={navigateSandbox}
        />
      ) : null}
      {pillOnly ? null : <SandboxPinBubbles />}
    </>
  );
}

export { AppFrameOverlay };
