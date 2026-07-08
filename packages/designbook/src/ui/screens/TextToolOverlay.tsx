/**
 * Text-tool overlay: highlights editable text nodes on hover and opens the
 * right editor on click, driven entirely by the configured text-adapter chain
 * (see `@designbook-ui/adapterRuntime`). Keyed claims open the rich template editor (with
 * inline editing when the DOM shape allows); plain literal claims open a simple
 * input; anything no adapter claims shows a callout with the owning component
 * and a suggested agent prompt.
 *
 * Mounted in place of CanvasOverlay when `tool === "text"`.
 */

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TextClaim } from "@designbookapp/designbook/config";
import { cn } from "@designbook-ui/lib/utils";
import { elementsFromPointWithin } from "@designbook-ui/isolationContext";
import { useStageTransform, useStageElement } from "./stageContext";
import { TextEditPopover } from "./TextEditPopover";
import { LiteralEditPopover } from "./LiteralEditPopover";
import { beginInlineEdit as beginInlineEditShared } from "@designbook-ui/models/text/inlineTextEdit";
import { TextProvider, useTextModel } from "@designbook-ui/models/text/TextProvider";
import type { OverlayRect } from "./CanvasOverlay";

const copy = {
  hardcodedLabel: "Hardcoded string",
  componentLabel: "Component:",
  extractPromptPrefix: "Extract this hardcoded string to i18n:",
  copyPromptButton: "Copy prompt",
  copiedLabel: "Copied",
};

type HoverState = {
  kind: "keyed" | "text";
  label: string;
  rect: OverlayRect;
};

type KeyedEditState = {
  claim: TextClaim;
  rect: OverlayRect;
  initialValues?: Record<string, string>;
};

type LiteralEditState = {
  claim: TextClaim;
  rect: OverlayRect;
};

type InlineEditState = {
  claim: TextClaim;
};

function screenRectToStageRect(
  screenRect: DOMRect,
  stageEl: HTMLElement,
  transform: { x: number; y: number; scale: number },
): OverlayRect {
  const stageBounds = stageEl.getBoundingClientRect();
  return {
    x: (screenRect.x - stageBounds.x - transform.x) / transform.scale,
    y: (screenRect.y - stageBounds.y - transform.y) / transform.scale,
    width: screenRect.width / transform.scale,
    height: screenRect.height / transform.scale,
  };
}

function HardcodedCallout({
  text,
  componentName,
  sourcePath,
  rect,
  stageTransform,
}: {
  text: string;
  componentName: string;
  sourcePath: string;
  rect: OverlayRect;
  stageTransform: { x: number; y: number; scale: number };
}) {
  const [copied, setCopied] = useState(false);

  const prompt = [
    copy.extractPromptPrefix,
    `String: "${text}"`,
    `Component: ${componentName}`,
    `Source: ${sourcePath}`,
    "",
    "Follow the i18n key-naming conventions in CLAUDE.md (context-based keys, @description metadata, placeholder documentation).",
  ].join("\n");

  function handleCopy() {
    void navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const left = rect.x * stageTransform.scale + stageTransform.x;
  const top =
    (rect.y + rect.height) * stageTransform.scale + stageTransform.y + 8;

  return (
    <div
      className="bg-popover absolute z-50 w-72 rounded-lg border border-tool-hardcoded/50 p-3 shadow-lg"
      style={{ left, top }}
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-tool-hardcoded-label">
          {copy.hardcodedLabel}
        </span>
        <span className="truncate text-sm">{text}</span>
        <span className="truncate text-xs text-muted-foreground">
          {copy.componentLabel} {componentName}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {sourcePath}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="self-start rounded bg-tool-hardcoded/10 px-3 py-1 text-xs text-tool-hardcoded-emphasis hover:bg-tool-hardcoded/20"
        >
          {copied ? copy.copiedLabel : copy.copyPromptButton}
        </button>
      </div>
    </div>
  );
}

function TextToolOverlayBody() {
  const model = useTextModel();
  const transform = useStageTransform();
  const stageEl = useStageElement();
  const [hover, setHover] = useState<HoverState | undefined>();
  const [keyedEdit, setKeyedEdit] = useState<KeyedEditState | undefined>();
  const [literalEdit, setLiteralEdit] = useState<LiteralEditState | undefined>();
  const [hardcodedCallout, setHardcodedCallout] = useState<
    | {
        text: string;
        componentName: string;
        sourcePath: string;
        rect: OverlayRect;
      }
    | undefined
  >();
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | undefined>();
  const rootRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const inlineCleanupRef = useRef<(() => void) | undefined>(undefined);

  const editing = keyedEdit || literalEdit;

  useEffect(() => () => inlineCleanupRef.current?.(), []);

  function commitInlineEdit(claim: TextClaim, value: string) {
    const plan = model.planInlineCommit(claim, value);
    if (plan.escalate && claim.element && stageEl) {
      const rect = screenRectToStageRect(
        claim.element.getBoundingClientRect(),
        stageEl,
        transform,
      );
      setKeyedEdit({ claim, rect, initialValues: plan.initialValues });
      return;
    }
    void claim.save(value).catch(() => {});
  }

  /**
   * Edits a keyed string in place via the shared `inlineTextEdit` mechanics
   * (same document/window as the canvas itself). Returns false when the
   * claim's shape doesn't allow it — the caller falls back to the popover
   * editor.
   */
  function beginInlineEdit(claim: TextClaim): boolean {
    const handle = beginInlineEditShared(claim, document, window, {
      onCommit: (value) => commitInlineEdit(claim, value),
      onEnd: () => {
        inlineCleanupRef.current = undefined;
        setInlineEdit(undefined);
      },
    });
    if (!handle) return false;

    inlineCleanupRef.current = handle.cancel;
    setInlineEdit({ claim });
    setHover(undefined);
    setHardcodedCallout(undefined);
    return true;
  }

  function elementUnderPointer(
    clientX: number,
    clientY: number,
  ): HTMLElement | undefined {
    const root = rootRef.current;
    if (!root) return undefined;
    const found = elementsFromPointWithin(root, clientX, clientY).find(
      (el) => !root.contains(el),
    );
    return found instanceof HTMLElement ? found : undefined;
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (editing || inlineEdit) return;

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const target = elementUnderPointer(event.clientX, event.clientY);
      if (!target || !stageEl) {
        setHover(undefined);
        return;
      }

      const hit = model.buildHit(target, stageEl);

      const preview = model.previewHit(hit);
      if (preview?.rect) {
        setHover({
          kind: "keyed",
          label: preview.label ?? preview.key ?? "",
          rect: screenRectToStageRect(preview.rect, stageEl, transform),
        });
        return;
      }

      if (hit.componentName && hit.text) {
        setHover({
          kind: "text",
          label: copy.hardcodedLabel,
          rect: screenRectToStageRect(hit.rect, stageEl, transform),
        });
        return;
      }

      setHover(undefined);
    });
  }

  function handlePointerLeave() {
    cancelAnimationFrame(rafRef.current);
    if (!editing) {
      setHover(undefined);
    }
  }

  async function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (editing || inlineEdit) return;

    const target = elementUnderPointer(event.clientX, event.clientY);
    if (!target || !stageEl) {
      setHardcodedCallout(undefined);
      return;
    }

    const hit = model.buildHit(target, stageEl);
    const claim = await model.resolveHit(hit);
    if (!stageEl) return;

    if (claim?.kind === "keyed") {
      setHover(undefined);
      setHardcodedCallout(undefined);
      if (beginInlineEdit(claim)) return;
      const rect = screenRectToStageRect(
        claim.rect ?? hit.rect,
        stageEl,
        transform,
      );
      setKeyedEdit({ claim, rect });
      return;
    }

    if (claim?.kind === "literal") {
      setHover(undefined);
      setHardcodedCallout(undefined);
      const rect = screenRectToStageRect(
        claim.rect ?? hit.rect,
        stageEl,
        transform,
      );
      setLiteralEdit({ claim, rect });
      return;
    }

    if (hit.componentName && hit.text) {
      setHardcodedCallout({
        text: hit.text.slice(0, 100),
        componentName: hit.componentName,
        sourcePath: hit.sourcePath ?? "",
        rect: screenRectToStageRect(hit.rect, stageEl, transform),
      });
      return;
    }

    setHardcodedCallout(undefined);
  }

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-10"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onClick={(event) => void handleClick(event)}
      style={{
        pointerEvents: inlineEdit ? "none" : "auto",
        cursor: "text",
      }}
    >
      <div
        className="pointer-events-none absolute origin-top-left"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
        }}
      >
        {hover && !editing ? (
          <div
            className={cn(
              "pointer-events-none absolute border-2 border-dashed",
              hover.kind === "keyed"
                ? "border-tool-keyed bg-tool-keyed/5"
                : "border-tool-hardcoded bg-tool-hardcoded/5",
            )}
            style={{
              left: hover.rect.x,
              top: hover.rect.y,
              width: hover.rect.width,
              height: hover.rect.height,
            }}
          >
            <span
              className={cn(
                "absolute -top-5 left-0 rounded px-1 text-[10px] leading-4 font-medium whitespace-nowrap",
                hover.kind === "keyed"
                  ? "bg-tool-keyed text-white"
                  : "bg-tool-hardcoded text-white",
              )}
            >
              {hover.label}
            </span>
          </div>
        ) : null}
      </div>

      {keyedEdit ? (
        <TextEditPopover
          claim={keyedEdit.claim}
          anchorRect={keyedEdit.rect}
          stageTransform={transform}
          initialValues={keyedEdit.initialValues}
          onClose={() => setKeyedEdit(undefined)}
        />
      ) : null}

      {literalEdit ? (
        <LiteralEditPopover
          claim={literalEdit.claim}
          anchorRect={literalEdit.rect}
          stageTransform={transform}
          onClose={() => setLiteralEdit(undefined)}
        />
      ) : null}

      {hardcodedCallout && !editing ? (
        <HardcodedCallout
          text={hardcodedCallout.text}
          componentName={hardcodedCallout.componentName}
          sourcePath={hardcodedCallout.sourcePath}
          rect={hardcodedCallout.rect}
          stageTransform={transform}
        />
      ) : null}
    </div>
  );
}

/**
 * Canvas text tool: the overlay body consumes the shared `text` model
 * (`useTextModel`) for hit-building, claim resolution, and the plural
 * inline-commit decision. Canvas saves straight through the adapter, so no
 * `decorateSave` is supplied (the model's default identity).
 */
function TextToolOverlay() {
  return (
    <TextProvider>
      <TextToolOverlayBody />
    </TextProvider>
  );
}

export { TextToolOverlay };
