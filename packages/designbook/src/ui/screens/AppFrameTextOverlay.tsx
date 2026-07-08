/**
 * Text tool over the App page's frame cell — inline editing with deterministic post-save freshness.
 *
 * Keyed claims whose DOM shape allows it (see `inlineTextEdit.ts`'s
 * `canInlineEditClaim` — the SAME predicate the canvas text tool uses) are
 * edited IN PLACE inside the frame document: contenteditable on the frame's
 * own node, the frame's own `Selection`/`Range`, keyboard captured in the
 * frame's realm so the live app's own shortcuts never see it. Anything more
 * complex (placeholders split across nodes, plurals, multi-node content) —
 * and all literal claims — keep the popover, exactly like canvas. The
 * mechanics are shared with `TextToolOverlay` via `inlineTextEdit.ts`,
 * parameterized over `document`/`window` so canvas (its own document) and this
 * frame tool (`iframe.contentDocument`/`contentWindow`, a different realm)
 * don't fork the logic.
 *
 * Marker runtime: mounted only while armed (`tool === "text"` AND
 * the App page is showing), so `window.__designbook.mark`/`textToolActive`
 * install/arm here, on the TOP window — the frame's `__dbMark` reads them via
 * `window.top` (see `markRuntime.ts`) since the frame's OWN boot never installs
 * them. Unmount (tool change, or leaving the App page) always disarms and
 * restores the canvas's own marker default — no dangling marked strings.
 *
 * Both arm/disarm and a saved edit reload the frame (`appFrameMark.ts`) rather
 * than reaching into its live i18n instance — see that module's doc comment
 * for why an in-place patch isn't reliable here. Each self-triggered reload is
 * paired with `ignoreNextNavigation()` so `Workbench.tsx` doesn't mistake it
 * for a real navigation and disarm the tool this reload is re-marking for.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  elementAtFramePoint,
  frameLocalRectToScreenRect,
  isElementNode,
  safeFrameDocument,
  safeFrameWindow,
} from "@designbook-ui/previewHost";
import type { TextClaim } from "@designbookapp/designbook/config";
import {
  installPageMark,
  refreshPageText,
  resetPageTextMarking,
  setTextToolActive,
} from "@designbook-ui/screens/pageTools/pageMark";
import { useFrameModel } from "@designbook-ui/models/frame/FrameProvider";
import { useStageElement, useStageTransform } from "./stageContext";
import { TextEditPopover } from "./TextEditPopover";
import { LiteralEditPopover } from "./LiteralEditPopover";
import { reloadFrame } from "@designbook-ui/models/frame/appFrameMark";
import { flushWrites } from "@designbook-ui/models/frame/appFrameFlush";
import { beginInlineEdit as beginInlineEditShared } from "@designbook-ui/models/text/inlineTextEdit";
import {
  TextProvider,
  useTextModel,
} from "@designbook-ui/models/text/TextProvider";
import type { SaveDecorator } from "@designbook-ui/models/text/textModel";
import { screenRectToStageRect, type OverlayRect } from "./CanvasOverlay";

const copy = {
  hardcodedLabel: "Hardcoded string",
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
type LiteralEditState = { claim: TextClaim; rect: OverlayRect };
type InlineEditState = { claim: TextClaim };

/**
 * Wrap a resolved claim so a successful save both (1) flushes the target app's
 * OWN dev-server module cache and (2) reloads the frame — in that order, only
 * once the flush settles (see the long note that used to live inline; P3.1
 * item 1). This is the frame surface's `decorateSave`, applied by the `text`
 * model to every claim it resolves here.
 */
function withFrameReloadOnSave(
  claim: TextClaim,
  iframe: HTMLIFrameElement | null,
  ignoreNextNavigation: () => void,
): TextClaim {
  async function reloadAfterWrite() {
    if (!iframe) return;
    await flushWrites();
    ignoreNextNavigation();
    reloadFrame(iframe);
  }
  return {
    ...claim,
    save: async (next: string) => {
      await claim.save(next);
      await reloadAfterWrite();
    },
    saveEntries: claim.saveEntries
      ? async (entries) => {
          await claim.saveEntries!(entries);
          await reloadAfterWrite();
        }
      : undefined,
  };
}

/**
 * App-page frame text tool: wraps the body in a `TextProvider` whose
 * `decorateSave` is `withFrameReloadOnSave` (flush-then-reload for deterministic
 * post-save freshness). The overlay body consumes the shared `text` model.
 */
function AppFrameTextOverlay({ onDisarm }: { onDisarm: () => void }) {
  const { iframe, ignoreNextNavigation } = useFrameModel();
  const decorateSave = useCallback<SaveDecorator>(
    (claim) => withFrameReloadOnSave(claim, iframe, ignoreNextNavigation),
    [iframe, ignoreNextNavigation],
  );
  return (
    <TextProvider decorateSave={decorateSave}>
      <AppFrameTextOverlayBody onDisarm={onDisarm} />
    </TextProvider>
  );
}

function AppFrameTextOverlayBody({ onDisarm }: { onDisarm: () => void }) {
  const model = useTextModel();
  const { iframe, ignoreNextNavigation } = useFrameModel();
  const transform = useStageTransform();
  const stageEl = useStageElement();

  const [hover, setHover] = useState<HoverState>();
  const [keyedEdit, setKeyedEdit] = useState<KeyedEditState>();
  const [literalEdit, setLiteralEdit] = useState<LiteralEditState>();
  const [inlineEdit, setInlineEdit] = useState<InlineEditState>();
  const rafRef = useRef(0);
  const inlineCleanupRef = useRef<(() => void) | undefined>(undefined);
  // Kept in sync with `inlineEdit` every render so the frame-realm Escape
  // listener below (registered once per `iframe`, not per render) always
  // reads the CURRENT value instead of a stale closure over the render it was
  // attached during.
  const inlineEditingRef = useRef(false);

  const editing = Boolean(keyedEdit || literalEdit || inlineEdit);
  inlineEditingRef.current = Boolean(inlineEdit);

  // Arm the marker runtime on mount (this component only exists while the text
  // tool is armed on the App page — see Workbench.tsx), disarm + repaint clean
  // on unmount (tool change or leaving the App page). Marking only takes effect
  // at RENDER time (the transform-wrapped `t()` re-runs `__dbMark`), so a frame
  // that already rendered before the tool armed needs a reload to show freshly
  // (or newly un-) marked strings — see `appFrameMark.ts` for why a reload,
  // not an in-place nudge. Re-runs if the frame itself changes (e.g. a manual
  // reload while the tool stays armed) so the new document gets re-marked too.
  useEffect(() => {
    installPageMark();
    setTextToolActive(true);
    void refreshPageText();
    if (iframe) {
      ignoreNextNavigation();
      reloadFrame(iframe);
    }
    return () => {
      resetPageTextMarking();
      void refreshPageText();
      if (iframe) {
        ignoreNextNavigation();
        reloadFrame(iframe);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ignoreNextNavigation is stable for the App page's lifetime
  }, [iframe]);

  // Abort a still-active inline edit on unmount (tool change / leaving the App
  // page) — mirrors `TextToolOverlay`'s identical cleanup. `cancel()` is a
  // no-op once the edit already ended on its own (blur/Enter/Escape).
  useEffect(() => () => inlineCleanupRef.current?.(), []);

  // Escape ladder, frame half: while an inline edit is active,
  // focus lives INSIDE the frame's own browsing context — a top-window
  // `keydown` listener never sees those keystrokes at all (iframes don't
  // bubble key events to their parent). The inline edit's OWN listener (see
  // `inlineTextEdit.ts`, attached directly to the edited element with
  // `stopPropagation: true`) already owns the FIRST Escape there. This
  // listener, attached to the frame's WINDOW in the capture phase (the
  // earliest point in that realm's dispatch order, ahead of anything the live
  // app itself might listen for), owns the SECOND: once nothing is being
  // edited, an Escape that still reaches here — coming from inside the frame —
  // disarms the tool instead of leaking to the app.
  useEffect(() => {
    if (!iframe) return;
    const frameWindow = safeFrameWindow(iframe);
    if (!frameWindow) return;
    function onFrameKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (inlineEditingRef.current) return; // the active edit's own listener owns this one.
      event.preventDefault();
      event.stopPropagation();
      onDisarm();
    }
    frameWindow.addEventListener("keydown", onFrameKeyDown, true);
    return () => frameWindow.removeEventListener("keydown", onFrameKeyDown, true);
  }, [iframe, onDisarm]);

  // Escape ladder, top half: a popover (`TextEditPopover`/
  // `LiteralEditPopover`) renders in the TOP document, so ITS OWN Escape
  // handler runs first (bubble phase, closer to the target) and closes it —
  // by the time this listener's closure is re-registered with the updated
  // `keyedEdit`/`literalEdit` (both now undefined), a SECOND, separate Escape
  // press disarms. `inlineEdit` never applies here: while it's active, focus
  // is inside the frame, so this (top) listener never even sees the keystroke.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (keyedEdit || literalEdit) return;
      event.preventDefault();
      onDisarm();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keyedEdit, literalEdit, onDisarm]);

  /** A rect measured inside the frame's document → stage space, ready for the
   * SAME transformed overlay container / popover positioning math the canvas's
   * own text tool uses (`screenRectToStageRect`, `TextEditPopover`). */
  function toStageRect(frameLocalRect: DOMRect): OverlayRect {
    if (!iframe || !stageEl) {
      return {
        x: frameLocalRect.x,
        y: frameLocalRect.y,
        width: frameLocalRect.width,
        height: frameLocalRect.height,
      };
    }
    const screenBox = frameLocalRectToScreenRect(iframe, frameLocalRect);
    return screenRectToStageRect(screenBox, stageEl, transform);
  }

  /** Commit an inline-edited value: a plural claim can't be fully represented
   * inline (only its singular text is on screen), so it escalates to the
   * popover pre-filled with the typed value instead of saving directly — the
   * SAME shared `planInlineCommit` decision the canvas text tool uses. */
  function commitInlineEdit(claim: TextClaim, value: string) {
    const plan = model.planInlineCommit(claim, value);
    if (plan.escalate && claim.element) {
      setKeyedEdit({
        claim,
        rect: toStageRect(claim.element.getBoundingClientRect()),
        initialValues: plan.initialValues,
      });
      return;
    }
    void claim.save(value).catch(() => {});
  }

  /** Try to start an in-place edit for `claim` (already decorated with the
   * frame reload-on-save) inside the frame's own document/window. Returns
   * false — no side effects — when the shape doesn't allow it or the frame's
   * document isn't reachable, so the caller falls back to the popover. */
  function tryBeginInlineEdit(claim: TextClaim): boolean {
    if (!iframe) return false;
    const frameDoc = safeFrameDocument(iframe);
    const frameWin = safeFrameWindow(iframe);
    if (!frameDoc || !frameWin) return false;

    const handle = beginInlineEditShared(claim, frameDoc, frameWin, {
      onCommit: (value) => commitInlineEdit(claim, value),
      onEnd: () => {
        inlineCleanupRef.current = undefined;
        setInlineEdit(undefined);
      },
      // Required inside a live app's own DOM (unlike the canvas): keeps the
      // app's own shortcut listeners from also reacting to the Enter/Escape
      // that ends the edit.
      stopPropagation: true,
    });
    if (!handle) return false;

    inlineCleanupRef.current = handle.cancel;
    setInlineEdit({ claim });
    return true;
  }

  function elementUnderPointer(x: number, y: number): HTMLElement | undefined {
    if (!iframe) return undefined;
    const found = elementAtFramePoint(iframe, x, y);
    // `instanceof HTMLElement` would fail here — `found` is an element from the
    // FRAME's own realm, checked against a DIFFERENT `HTMLElement` constructor
    // than the one this code's `instanceof` would compare against (see
    // `isElementNode` in fibers.ts for the cross-realm explanation).
    return found && isElementNode(found) ? (found as HTMLElement) : undefined;
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
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
      if (preview?.rect) {
        setHover({
          rect: toStageRect(preview.rect),
          label: preview.label ?? preview.key ?? "",
        });
      } else {
        setHover(undefined);
      }
    });
  }

  async function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (editing) return;
    const target = elementUnderPointer(event.clientX, event.clientY);
    if (!target) return;

    const hit = model.buildHit(target);
    // `resolveHit` already applies this surface's `withFrameReloadOnSave`
    // decorator (via the provider), so the resolved claim's save flushes then
    // reloads the frame.
    const claim = await model.resolveHit(hit);
    if (!iframe) return;

    if (claim?.kind === "keyed") {
      setHover(undefined);
      if (tryBeginInlineEdit(claim)) return;
      setKeyedEdit({
        claim,
        rect: toStageRect(claim.rect ?? hit.rect),
      });
      return;
    }

    if (claim?.kind === "literal") {
      setHover(undefined);
      setLiteralEdit({
        claim,
        rect: toStageRect(claim.rect ?? hit.rect),
      });
      return;
    }
  }

  if (!iframe) return null;

  return (
    <div
      className="absolute inset-0 z-10"
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHover(undefined)}
      onClick={(event) => void handleClick(event)}
      // "auto" whenever a popover is open (it doesn't set its own
      // pointer-events, so an ancestor "none" would make it unclickable too) —
      // but "none" during an INLINE edit, so clicks/typing reach the editable
      // node inside the frame underneath this div instead of being captured by
      // it. `handlePointerMove`/`handleClick` already no-op while `editing`.
      style={{ pointerEvents: inlineEdit ? "none" : "auto", cursor: "text" }}
    >
      <div
        className="pointer-events-none absolute origin-top-left"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
        }}
      >
        {hover && !editing ? (
          <div
            className="pointer-events-none absolute border-2 border-dashed border-tool-keyed bg-tool-keyed/5"
            style={{
              left: hover.rect.x,
              top: hover.rect.y,
              width: hover.rect.width,
              height: hover.rect.height,
            }}
          >
            <span className="absolute -top-5 left-0 rounded bg-tool-keyed px-1 text-[10px] leading-4 font-medium whitespace-nowrap text-white">
              {hover.label || copy.hardcodedLabel}
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
    </div>
  );
}

export { AppFrameTextOverlay };
