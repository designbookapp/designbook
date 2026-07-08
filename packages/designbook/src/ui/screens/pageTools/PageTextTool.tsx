/**
 * Live-page text tool (M spec, M2) — the page-space counterpart of the canvas
 * `TextToolOverlay`.
 *
 * When armed, the app's marker-instrumented `t()` output lights up: hovering a
 * marked string highlights it; clicking a keyed claim whose DOM shape allows it
 * (see `inlineTextEdit.ts`'s `canInlineEditClaim` — the SAME predicate the
 * canvas and frame text tools use) edits it IN PLACE on the live page:
 * contenteditable on the string's own node, commit on Enter/blur, Escape
 * cancels + restores. A claim that can't be edited inline (placeholders split
 * across nodes, plurals, multi-node content) — and a plural that WAS started
 * inline but must escalate on commit (`model.planInlineCommit`, mirroring
 * canvas/frame) — opens the SAME `TextEditPopover`, resolved through the SAME
 * adapter chain and saved through the SAME adapter write path as the canvas. A
 * saved edit (inline or popover) is also pushed into the app's live i18n
 * instance so the page updates without a reload. A hardcoded literal under the
 * tool gets a small "not an i18n string — ask Pi" affordance that opens the M1
 * drawer prefilled — never an inline guess.
 *
 * Geometry is viewport space (identity transform), so a claim's screen rect is
 * used directly. The capture layer opts into pointer events only while armed
 * (and is disabled during an inline edit so clicks/typing reach the editable
 * node underneath, mirroring the canvas); the popover stops keyboard events,
 * and the inline edit's own listener uses `stopPropagation: true` (this is the
 * live app's REAL DOM, unlike the canvas), so typing never reaches the live
 * app's global shortcut handlers.
 *
 * Escape ladder note: `PageTools`'s window `keydown` listener runs in the
 * CAPTURE phase, ahead of the inline edit's own (bubble-phase, "at target")
 * Escape handler — so that shared handler never actually fires here. Canceling
 * an in-progress inline edit is instead wired through `closePopover()` (the
 * SAME imperative escape hook the popover/affordance already use), which calls
 * the inline edit handle's own `cancel()` — restoring text and tearing down
 * listeners exactly as a "real" Escape would.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import type { TextClaim } from "@designbookapp/designbook/config";
import { TextEditPopover } from "@designbook-ui/screens/TextEditPopover";
import type { OverlayRect } from "@designbook-ui/screens/CanvasOverlay";
import {
  TextProvider,
  useTextModel,
} from "@designbook-ui/models/text/TextProvider";
import type { SaveDecorator } from "@designbook-ui/models/text/textModel";
import { beginInlineEdit as beginInlineEditShared } from "@designbook-ui/models/text/inlineTextEdit";
import { applyEditToApp } from "./pageMark";

const IDENTITY = { x: 0, y: 0, scale: 1 };

const copy = {
  askPiTitle: "Not an i18n string",
  askPiBody: "This text isn't a translation key.",
  askPiButton: "Ask Pi",
};

function boxFromRect(rect: DOMRect): OverlayRect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Whether a viewport point is inside a rect (small slop for sub-pixel edges).
 * Page-mode `textHitTest` walks ancestors up to `<body>` and returns the FIRST
 * marked text node in that subtree, so a claim resolved for a click on unrelated
 * chrome can point at a distant string; requiring the claim's rect to contain the
 * pointer keeps hover/selection on the text actually under it.
 */
function rectContains(rect: DOMRect | undefined, x: number, y: number): boolean {
  if (!rect) return false;
  const slop = 1;
  return (
    x >= rect.left - slop &&
    x <= rect.right + slop &&
    y >= rect.top - slop &&
    y <= rect.bottom + slop
  );
}

/**
 * Wrap a resolved claim so a successful save is also reflected into the app's
 * live i18n instance (the canvas adapter only updates the workbench instance).
 * That is what makes the LIVE page text update without a reload. Supplied to the
 * `text` model as its `decorateSave`, so every claim the model resolves on this
 * surface carries the live-apply side effect.
 */
const withLiveApply: SaveDecorator = function withLiveApply(claim: TextClaim): TextClaim {
  const namespace = claim.namespace ?? "";
  const apply = (entries: Array<{ key: string; value: string }>) => {
    void applyEditToApp(namespace, entries);
  };
  return {
    ...claim,
    save: async (next: string) => {
      await claim.save(next);
      if (claim.key) apply([{ key: claim.key, value: next }]);
    },
    saveEntries: claim.saveEntries
      ? async (entries) => {
          await claim.saveEntries!(entries);
          apply(entries);
        }
      : undefined,
  };
};

type HoverState = { rect: OverlayRect; label: string };
type KeyedEditState = {
  claim: TextClaim;
  rect: OverlayRect;
  /** Draft values keyed by full resource key — set when a plural claim was
   * started as an inline edit (its singular text swapped in place) and had to
   * escalate to the popover on commit; mirrors canvas's `commitInlineEdit`. */
  initialValues?: Record<string, string>;
};
type InlineEditState = { claim: TextClaim };
type AskPiState = {
  rect: OverlayRect;
  text: string;
  componentName?: string;
  sourcePath?: string;
};

/**
 * Imperative escape ladder handle: `PageTools`'s window-level Escape
 * listener owns tool-disarm, but the popover/affordance state lives here — so
 * it asks THIS component to close whatever is open first. Returns whether
 * something was actually open (and got closed), so the caller knows to swallow
 * the keypress without also disarming the tool.
 */
type PageTextToolHandle = {
  closePopover: () => boolean;
};

function AskPiAffordance({
  state,
  onAskPi,
  onDismiss,
}: {
  state: AskPiState;
  onAskPi: () => void;
  onDismiss: () => void;
}) {
  const left = Math.max(8, Math.min(state.rect.x, window.innerWidth - 240));
  const top = state.rect.y + state.rect.height + 8;
  return (
    <div
      className="pointer-events-auto absolute z-50 w-56 rounded-lg border border-tool-hardcoded/50 bg-popover p-3 text-popover-foreground shadow-lg"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-tool-hardcoded-label">
          {copy.askPiTitle}
        </span>
        <span className="truncate text-sm">{state.text}</span>
        <span className="text-xs text-muted-foreground">{copy.askPiBody}</span>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={onAskPi}
            className="rounded bg-tool-hardcoded/10 px-2 py-1 text-xs text-tool-hardcoded-emphasis hover:bg-tool-hardcoded/20"
          >
            {copy.askPiButton}
          </button>
        </div>
      </div>
    </div>
  );
}

type PageTextToolProps = {
  /** Whether the text tool is armed (owns pointer capture + marking). */
  active: boolean;
  /** The page-tools host element — excluded from live-DOM hit testing. */
  hostEl: Element;
  /** Open the Pi drawer prefilled for a hardcoded string (never a guess). */
  onAskPi: (prefill: string) => void;
};

const PageTextToolBody = forwardRef<PageTextToolHandle, PageTextToolProps>(
  function PageTextToolBody({ active, hostEl, onAskPi }, ref) {
  const model = useTextModel();
  const [hover, setHover] = useState<HoverState>();
  const [keyedEdit, setKeyedEdit] = useState<KeyedEditState>();
  const [askPi, setAskPi] = useState<AskPiState>();
  const [inlineEdit, setInlineEdit] = useState<InlineEditState>();
  const rafRef = useRef(0);
  const inlineCleanupRef = useRef<(() => void) | undefined>(undefined);

  const editing = Boolean(keyedEdit || inlineEdit);

  // Escape ladder: the FIRST Escape while a popover/affordance/inline edit
  // is open closes only that — the tool stays armed. `PageTools`'s window-level
  // listener calls this before its own disarm branch; a `true` return means it
  // swallowed the key itself.
  //
  // Inline edit's OWN Escape handler (in `inlineTextEdit.ts`, attached to the
  // edited element) never actually fires here: `PageTools`'s window `keydown`
  // listener runs in the CAPTURE phase, ahead of that element-level (bubble /
  // "at target") handler, and calls `stopImmediatePropagation()` once it knows
  // this returned true — so canceling an in-progress inline edit is wired
  // through the SAME `cancel()` the shared module's own Escape would have
  // called, just invoked from here instead.
  useImperativeHandle(
    ref,
    () => ({
      closePopover() {
        if (inlineEdit) {
          inlineCleanupRef.current?.();
          return true;
        }
        if (keyedEdit) {
          setKeyedEdit(undefined);
          return true;
        }
        if (askPi) {
          setAskPi(undefined);
          return true;
        }
        return false;
      },
    }),
    [inlineEdit, keyedEdit, askPi],
  );

  // Reset transient UI whenever the tool disarms.
  useEffect(() => {
    if (!active) {
      setHover(undefined);
      setKeyedEdit(undefined);
      setAskPi(undefined);
      inlineCleanupRef.current?.();
    }
  }, [active]);

  // Abort a still-active inline edit on unmount — mirrors the canvas/frame text
  // tools' identical cleanup. `cancel()` is a no-op once the edit already ended
  // on its own (blur/Enter, or the escape ladder above).
  useEffect(() => () => inlineCleanupRef.current?.(), []);

  function elementUnderPointer(x: number, y: number): HTMLElement | undefined {
    const found = document
      .elementsFromPoint(x, y)
      .find((el) => !hostEl.contains(el));
    return found instanceof HTMLElement ? found : undefined;
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (editing) return;
    const { clientX, clientY } = event;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const target = elementUnderPointer(clientX, clientY);
      if (!target) {
        setHover(undefined);
        return;
      }
      const preview = model.previewHit(model.buildHit(target));
      if (preview?.rect && rectContains(preview.rect, clientX, clientY)) {
        setHover({
          rect: boxFromRect(preview.rect),
          label: preview.label ?? preview.key ?? "",
        });
      } else {
        setHover(undefined);
      }
    });
  }

  /** Commit an inline-edited value: a plural claim can't be fully represented
   * inline (only its singular text is on screen), so it escalates to the
   * popover pre-filled with the typed value instead of saving directly — the
   * SAME shared `planInlineCommit` decision the canvas/frame text tools use. */
  function commitInlineEdit(claim: TextClaim, value: string) {
    const plan = model.planInlineCommit(claim, value);
    if (plan.escalate && claim.element) {
      setKeyedEdit({
        claim,
        rect: boxFromRect(claim.rect ?? claim.element.getBoundingClientRect()),
        initialValues: plan.initialValues,
      });
      return;
    }
    void claim.save(value).catch(() => {});
  }

  /**
   * Edits a keyed string in place via the shared `inlineTextEdit` mechanics
   * (this IS the live app's own document/window — there's no iframe realm to
   * cross here, unlike the frame tool). Returns false when the claim's shape
   * doesn't allow it, so the caller falls back to the popover editor.
   * `stopPropagation: true` keeps the live app's own global shortcut handlers
   * (real DOM, unlike the canvas) from also seeing the Enter/Escape that ends
   * the edit.
   */
  function tryBeginInlineEdit(claim: TextClaim): boolean {
    const handle = beginInlineEditShared(claim, document, window, {
      onCommit: (value) => commitInlineEdit(claim, value),
      onEnd: () => {
        inlineCleanupRef.current = undefined;
        setInlineEdit(undefined);
      },
      stopPropagation: true,
    });
    if (!handle) return false;

    inlineCleanupRef.current = handle.cancel;
    setInlineEdit({ claim });
    return true;
  }

  async function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (editing) return;
    const { clientX, clientY } = event;
    const target = elementUnderPointer(clientX, clientY);
    if (!target) {
      setAskPi(undefined);
      return;
    }
    const hit = model.buildHit(target);
    // `resolveHit` already applies this surface's `withLiveApply` decorator, so
    // the resolved keyed claim's save also pushes into the live i18n instance.
    const resolved = await model.resolveHit(hit);
    // Only accept a keyed claim whose text is actually under the pointer (see
    // `rectContains`) — otherwise a click on chrome resolves to a distant string.
    const claim =
      resolved?.kind === "keyed" &&
      rectContains(resolved.rect, clientX, clientY)
        ? resolved
        : undefined;

    if (claim?.kind === "keyed") {
      setHover(undefined);
      setAskPi(undefined);
      if (tryBeginInlineEdit(claim)) return;
      setKeyedEdit({
        claim,
        rect: boxFromRect(claim.rect ?? hit.rect),
      });
      return;
    }

    // No i18n claim: offer to hand a hardcoded string to Pi (never an inline
    // guess). Requires visible text so we don't pop up on empty chrome.
    if (hit.text) {
      setHover(undefined);
      setAskPi({
        rect: boxFromRect(hit.rect),
        text: hit.text.slice(0, 100),
        componentName: hit.componentName,
        sourcePath: hit.sourcePath,
      });
      return;
    }
    setAskPi(undefined);
  }

  function askPiPrefill(state: AskPiState): string {
    const lines = [`Extract this hardcoded string to i18n:`, `String: "${state.text}"`];
    if (state.componentName) lines.push(`Component: ${state.componentName}`);
    if (state.sourcePath) lines.push(`Source: ${state.sourcePath}`);
    lines.push("");
    return lines.join("\n");
  }

  if (!active) return null;

  return (
    <div
      className="fixed inset-0"
      // "none" during an INLINE edit (mirrors the canvas/frame text tools) so
      // clicks/typing reach the editable node in the live page underneath
      // this capture layer instead of being swallowed by it; popovers below
      // set their own pointer-events, so they stay clickable either way.
      style={{ pointerEvents: inlineEdit ? "none" : "auto", cursor: "text" }}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHover(undefined)}
      onClick={(event) => void handleClick(event)}
    >
      {hover && !editing ? (
        <div
          className="pointer-events-none fixed border-2 border-dashed border-tool-keyed bg-tool-keyed/5"
          style={{
            left: hover.rect.x,
            top: hover.rect.y,
            width: hover.rect.width,
            height: hover.rect.height,
          }}
        >
          <span className="absolute -top-5 left-0 rounded bg-tool-keyed px-1 text-[10px] leading-4 font-medium whitespace-nowrap text-white">
            {hover.label}
          </span>
        </div>
      ) : null}

      {keyedEdit ? (
        <div
          className="pointer-events-auto"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
        >
          <TextEditPopover
            claim={keyedEdit.claim}
            anchorRect={keyedEdit.rect}
            stageTransform={IDENTITY}
            initialValues={keyedEdit.initialValues}
            onClose={() => setKeyedEdit(undefined)}
          />
        </div>
      ) : null}

      {askPi ? (
        <AskPiAffordance
          state={askPi}
          onAskPi={() => {
            onAskPi(askPiPrefill(askPi));
            setAskPi(undefined);
          }}
          onDismiss={() => setAskPi(undefined)}
        />
      ) : null}
    </div>
  );
});

/**
 * Live-page text tool: wraps the body in a `TextProvider` so it consumes the
 * shared `text` model. `withLiveApply` is the surface's `decorateSave` — every
 * claim the model resolves here also reflects its save into the app's running
 * i18n instance, so the live page updates without a reload.
 */
const PageTextTool = forwardRef<PageTextToolHandle, PageTextToolProps>(
  function PageTextTool(props, ref) {
    return (
      <TextProvider decorateSave={withLiveApply}>
        <PageTextToolBody ref={ref as Ref<PageTextToolHandle>} {...props} />
      </TextProvider>
    );
  },
);

export { PageTextTool };
export type { PageTextToolHandle };
