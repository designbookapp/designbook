/**
 * Page-tools layer (M spec, M1) — the injected-mode middle state between the
 * pill and the full canvas.
 *
 * Mounted by `WorkbenchHandle.openPageTools` into its OWN shadow host (so it
 * stays visible while the canvas overlay is collapsed) and driven entirely by
 * local state: a compact strip (select · chat · expand · close), a page-space
 * select tool over the live app DOM, a selection chip (Prompt Pi / Go to
 * component / dismiss), and a docked Pi drawer sharing the same server session.
 *
 * Pointer discipline (watch-out): the host is `pointer-events: none`; only the
 * chrome (strip/chip/drawer) and — WHILE the select tool is armed — a
 * full-viewport capture layer opt back into `auto`, so a strip open with no tool
 * leaves the app fully interactive.
 *
 * Escape ladder: a chip or the text tool's popover/affordance consumes
 * ONE Escape to close itself; only a SECOND Escape (nothing left open) disarms
 * the active tool. Always swallowed (window capture) while armed so it never
 * leaks to the app.
 */

import { useEffect, useRef, useState } from "react";
import {
  MaximizeIcon,
  MessageSquareIcon,
  MousePointerClickIcon,
  TypeIcon,
  XIcon,
} from "lucide-react";
import { DesignChat } from "@designbook-ui/screens/DesignChat";
import { cn } from "@designbook-ui/lib/utils";
import { config } from "@designbook-ui/designbook";
import {
  buildPagePromptPrefill,
  canGoToComponent,
  chipLabel,
  nextToolState,
  type PageHit,
  type ToolState,
} from "./pageHit";
import { resolvePageHit } from "./resolvePageHit";
import { installToolIntercept } from "@designbook-ui/screens/toolIntercept";
import { PageTextTool, type PageTextToolHandle } from "./PageTextTool";
import {
  installPageMark,
  refreshPageText,
  resetPageTextMarking,
  setTextToolActive,
} from "./pageMark";
import {
  armInstanceInstrumentation,
  disarmInstanceInstrumentation,
  type InstrumentableI18n,
} from "./pageTextInstrument";

const copy = {
  select: "Select",
  text: "Edit text",
  chat: "Chat with Pi",
  expand: "Open canvas",
  close: "Close",
  promptPi: "Prompt Pi",
  goToComponent: "Go to component",
  dismiss: "Dismiss",
  drawerTitle: "Pi",
};

function OverlayBox({
  hit,
  type,
}: {
  hit: PageHit;
  type: "hover" | "selection";
}) {
  const isSelection = type === "selection";
  return (
    <div
      className={cn(
        "pointer-events-none fixed border",
        isSelection ? "border-primary bg-primary/5" : "border-primary/50",
      )}
      style={{
        left: hit.rect.x,
        top: hit.rect.y,
        width: hit.rect.width,
        height: hit.rect.height,
      }}
    >
      <span
        className={cn(
          "absolute -top-5 left-0 rounded px-1 text-[10px] leading-4 font-medium whitespace-nowrap",
          isSelection
            ? "bg-primary text-primary-foreground"
            : "bg-primary/80 text-primary-foreground",
        )}
      >
        {chipLabel(hit)}
      </span>
    </div>
  );
}

/** The action chip anchored at a selection. */
function SelectionChip({
  hit,
  onPromptPi,
  onGoToComponent,
  onDismiss,
}: {
  hit: PageHit;
  onPromptPi: () => void;
  onGoToComponent: () => void;
  onDismiss: () => void;
}) {
  // Anchor just below the selection's top-left, clamped into the viewport.
  const left = Math.max(8, Math.min(hit.rect.x, window.innerWidth - 240));
  const top = Math.max(8, hit.rect.y + hit.rect.height + 6);
  return (
    <div
      className="pointer-events-auto fixed z-10 flex items-center gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="max-w-40 truncate px-1.5 text-xs font-medium">
        {chipLabel(hit)}
      </span>
      <button
        type="button"
        className="cursor-default rounded-sm px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
        onClick={onPromptPi}
      >
        {copy.promptPi}
      </button>
      {canGoToComponent(hit) ? (
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
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function StripButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-8 cursor-default items-center justify-center rounded-md text-sm",
        active
          ? "bg-primary text-primary-foreground"
          : "text-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PageTools({
  hostEl,
  onExpandCanvas,
  onClose,
}: {
  /** The page-tools host element — excluded from live-DOM hit testing. */
  hostEl: Element;
  /** Open the full canvas, optionally navigating to a component entry first. */
  onExpandCanvas: (entryId?: string) => void;
  /** Tear down page tools and restore the pill. */
  onClose: () => void;
}) {
  const [toolState, setToolState] = useState<ToolState>({
    tool: null,
    chatOpen: false,
  });
  const { tool, chatOpen } = toolState;
  const [hoverHit, setHoverHit] = useState<PageHit>();
  const [selectedHit, setSelectedHit] = useState<PageHit>();
  const [draft, setDraft] = useState("");
  const rafRef = useRef(0);
  const textToolRef = useRef<PageTextToolHandle>(null);

  // Install the page-side marker helper (`window.__designbook.mark`) so the
  // app's transform-wrapped `t()` calls can register attribution into the shared
  // marker table once the text tool arms. Idempotent; refreshes the default ns.
  useEffect(() => {
    installPageMark();
  }, []);

  // Text tool arm/disarm: flip the marking flag and force the app to re-render
  // so every `t()` re-resolves through (or drops) the marker — markers appear
  // ONLY while armed and vanish on disarm. When the build transform is off, the
  // instance-instrumentation fallback registers the marker postProcessor on the
  // app's own i18n instance (`config.pageText.i18n`) and toggles it here.
  useEffect(() => {
    const armed = tool === "text";
    setTextToolActive(armed);
    const appI18n = config.pageText?.i18n?.() as InstrumentableI18n | undefined;
    if (appI18n) {
      if (armed) armInstanceInstrumentation(appI18n);
      else disarmInstanceInstrumentation(appI18n);
    }
    void refreshPageText();
  }, [tool]);

  // On teardown (page tools closed): restore the default marking state (canvas
  // markers back on, transform markers off) and repaint the app clean so no
  // markers linger in the live DOM.
  useEffect(() => {
    return () => {
      resetPageTextMarking();
      void refreshPageText();
    };
  }, []);

  function elementUnderPointer(x: number, y: number): Element | undefined {
    return document.elementsFromPoint(x, y).find((el) => !hostEl.contains(el));
  }

  function handlePointerMove(event: React.PointerEvent) {
    const { clientX, clientY } = event;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = elementUnderPointer(clientX, clientY);
      setHoverHit(el ? resolvePageHit(el) : undefined);
    });
  }

  // Driven by the capture-phase interceptor while armed (never by React —
  // the intercepted events are swallowed before they reach any handler the
  // app OR our React root could see). Native event: coordinates intact.
  function handleClick(event: MouseEvent) {
    const el = elementUnderPointer(event.clientX, event.clientY);
    setSelectedHit(el ? resolvePageHit(el) : undefined);
  }

  function dismissChip() {
    setSelectedHit(undefined);
  }

  // Escape ladder: dismiss the select chip, else close the text tool's
  // open popover/affordance, else disarm the active tool. Each step consumes
  // ONE Escape and stops there — a chip/popover always gets its own keypress
  // before the tool disarms — and the key is swallowed (capture phase, on
  // `window`) at every step so it never reaches the live app while a tool is
  // armed or an overlay is open.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (selectedHit) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dismissChip();
        return;
      }
      if (tool === "text" && textToolRef.current?.closePopover()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (tool) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setToolState((s) => nextToolState(s, { type: "escape", chipOpen: false }));
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [tool, selectedHit]);

  const armed = tool === "select";

  // Full capture-phase interception while the select tool is armed: swallow
  // the whole pointer sequence at the (app's own) window before ANY app
  // handler — document-capture ones included — or default action can run,
  // and drive selection from the interceptor (see toolIntercept.ts). The
  // strip/chip/drawer are siblings of the capture layer, so their own events
  // pass through untouched.
  const captureLayerRef = useRef<HTMLDivElement>(null);
  const handleClickRef = useRef(handleClick);
  handleClickRef.current = handleClick;
  useEffect(() => {
    const layer = captureLayerRef.current;
    if (!armed || !layer) return;
    return installToolIntercept(layer, {
      click: (event) => handleClickRef.current(event),
    });
  }, [armed]);

  const showHover =
    armed &&
    hoverHit &&
    !(
      selectedHit &&
      hoverHit.rect.x === selectedHit.rect.x &&
      hoverHit.rect.y === selectedHit.rect.y
    );

  return (
    <>
      {/* Capture / overlay layer: opts into pointer events only while armed. */}
      <div
        ref={captureLayerRef}
        className="fixed inset-0"
        style={{
          pointerEvents: armed ? "auto" : "none",
          cursor: armed ? "crosshair" : "default",
        }}
        onPointerMove={armed ? handlePointerMove : undefined}
        onPointerLeave={() => setHoverHit(undefined)}
      >
        {showHover ? <OverlayBox hit={hoverHit} type="hover" /> : null}
        {selectedHit ? <OverlayBox hit={selectedHit} type="selection" /> : null}
      </div>

      {/* Text tool: page-space marked-string editing. Owns its own capture
          layer while armed; a hardcoded string routes to the Pi drawer. */}
      <PageTextTool
        ref={textToolRef}
        active={tool === "text"}
        hostEl={hostEl}
        onAskPi={(prefill) => {
          setDraft(prefill);
          setToolState((s) => nextToolState(s, { type: "promptPi" }));
        }}
      />

      {selectedHit ? (
        <SelectionChip
          hit={selectedHit}
          onPromptPi={() => {
            setDraft(buildPagePromptPrefill(selectedHit));
            setToolState((s) => nextToolState(s, { type: "promptPi" }));
            dismissChip();
          }}
          onGoToComponent={() => onExpandCanvas(selectedHit.entryId)}
          onDismiss={dismissChip}
        />
      ) : null}

      {/* Docked Pi drawer — shares the same server session as the canvas chat.
          Keyboard events are stopped at the drawer so typing in the (shadow-DOM)
          textarea never reaches the LIVE app's global shortcut handlers — the
          app's document listener would otherwise see the event retargeted to our
          non-editable shadow host and fire a shortcut (e.g. excalidraw tool
          swaps). */}
      {chatOpen ? (
        <div
          className="pointer-events-auto fixed z-10 flex flex-col overflow-hidden rounded-lg border bg-background shadow-2xl"
          style={{
            right: 16,
            bottom: 76,
            width: 400,
            height: "min(70vh, 640px)",
          }}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">{copy.drawerTitle}</span>
            <button
              type="button"
              aria-label={copy.close}
              className="cursor-default rounded-sm p-1 hover:bg-accent hover:text-accent-foreground"
              onClick={() =>
                setToolState((s) => nextToolState(s, { type: "toggleChat" }))
              }
            >
              <XIcon className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <DesignChat embedded draft={draft} onDraftChange={setDraft} />
          </div>
        </div>
      ) : null}

      {/* Strip: bottom-right, same tier as the pill. */}
      <div
        className="pointer-events-auto fixed z-10 flex items-center gap-1 rounded-full border bg-popover p-1 text-popover-foreground shadow-lg"
        style={{ right: 16, bottom: 16 }}
      >
        <StripButton
          label={copy.select}
          active={armed}
          onClick={() =>
            setToolState((s) => nextToolState(s, { type: "toggleSelect" }))
          }
        >
          <MousePointerClickIcon className="size-4" />
        </StripButton>
        <StripButton
          label={copy.text}
          active={tool === "text"}
          onClick={() =>
            setToolState((s) => nextToolState(s, { type: "toggleText" }))
          }
        >
          <TypeIcon className="size-4" />
        </StripButton>
        <StripButton
          label={copy.chat}
          active={chatOpen}
          onClick={() =>
            setToolState((s) => nextToolState(s, { type: "toggleChat" }))
          }
        >
          <MessageSquareIcon className="size-4" />
        </StripButton>
        <StripButton label={copy.expand} onClick={() => onExpandCanvas()}>
          <MaximizeIcon className="size-4" />
        </StripButton>
        <StripButton label={copy.close} onClick={onClose}>
          <XIcon className="size-4" />
        </StripButton>
      </div>
    </>
  );
}

export { PageTools };
