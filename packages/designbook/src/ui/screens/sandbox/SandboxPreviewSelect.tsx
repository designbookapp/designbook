/**
 * Element selection INSIDE a sandbox canvas variant preview (page-mode drawer
 * canvas). While the page Select tool is armed, each ready variant card mounts
 * this layer over its rendered preview: hovering highlights the element a
 * click would select (the page select tool's visuals), clicking selects it,
 * and a compact anchored prompt box (target label + textarea) submits an
 * ITERATE turn on that variant carrying a descriptor of the selected element.
 *
 * Hit testing REUSES the page machinery (resolvePageHit's fiber+DOM walk over
 * the live tree — previews are real React trees slotted into the light DOM),
 * SCOPED to this preview's subtree via the `within` boundary: the chain is
 * trimmed at the preview root, so drilling can never escape one variant into
 * canvas/drawer chrome or a sibling preview. Drill gestures mirror the page:
 * click = outermost level within the variant, double-click/Enter = one level
 * in, Cmd/Ctrl+click = deepest registered component (registered atoms inside
 * the variant count as levels — same interleaved chain builder).
 *
 * Clicks that hit no preview element (card padding) fall back to the FRAME
 * pick (`onFramePick`) — the existing frame-level iterate flow.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Spinner } from "@designbook-ui/components/ui/spinner";
import { Textarea } from "@designbook-ui/components/ui/textarea";
import { cn } from "@designbook-ui/lib/utils";
import { elementsFromPointWithin } from "@designbook-ui/isolationContext";
import {
  buildIterateElementDescriptor,
  type SandboxIterateElementDescriptor,
} from "@designbook-ui/models/sandbox/iterateDescriptor";
import type { Box, PageHit } from "@designbook-ui/screens/pageTools/pageHit";
import {
  resolvePageClick,
  resolvePageDeepClick,
  resolvePageDoubleClick,
  resolvePageHover,
} from "@designbook-ui/screens/pageTools/resolvePageHit";
import {
  anchoredPromptBoxPosition,
  relativeToLayer,
} from "./previewSelectBox";

/** Marks a variant preview's LIGHT-DOM root (the measure div) so the select
 * layer can scope hit-testing to exactly one preview subtree. */
const PREVIEW_ROOT_ATTR = "data-db-sandbox-preview-root";

/** Attribute value identifying one (pin, variant) preview. */
function previewRootKey(pinId: string, variantId: string): string {
  return `${pinId}:${variantId}`;
}

/** An element selection inside ONE variant preview. */
type PreviewElementSelection = {
  hit: PageHit;
  /** Drill path (instanceIds, outermost first) — page drill semantics. */
  drillPath: string[];
};

const copy = {
  placeholder: "Change this element…",
  send: "Send",
  working: "Working…",
};

const PROMPT_BOX_WIDTH = 256;
const PROMPT_BOX_HEIGHT = 104;

/** Selected-element descriptor for the iterate turn (tag+classes, trimmed
 * outerHTML, text) — read from the live hit at submit time. */
function descriptorFromHit(hit: PageHit): SandboxIterateElementDescriptor {
  const el = hit.anchor;
  return buildIterateElementDescriptor({
    tag: hit.dom?.tag ?? el?.tagName.toLowerCase() ?? "element",
    id: hit.dom?.id ?? (el?.id || undefined),
    classes:
      hit.dom?.classes ??
      (el && el.classList.length > 0 ? Array.from(el.classList) : undefined),
    label: hit.label,
    text: el?.textContent ?? undefined,
    outerHtml: el?.outerHTML,
    componentHint:
      hit.kind === "component" ? (hit.entryLabel ?? hit.label) : hit.hint,
  });
}

/** True when a keydown originated in an editable element (shadow-DOM
 * textareas included — `composedPath` pierces shadow roots). */
function isEditableKeyTarget(event: KeyboardEvent): boolean {
  const target = event.composedPath()[0];
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "INPUT" ||
    tag === "SELECT" ||
    (target as HTMLElement).isContentEditable
  );
}

function boxFromRect(rect: DOMRect): Box {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** The hit's CURRENT viewport rect: re-measured off the live anchor (card
 * scroll/content shifts), falling back to the rect captured at click time. */
function currentHitRect(hit: PageHit): Box {
  if (hit.anchor?.isConnected) {
    return boxFromRect(hit.anchor.getBoundingClientRect());
  }
  return hit.rect;
}

/** Hover/selection highlight (the page OverlayBox visuals, layer-local). */
function PreviewOverlayBox({
  box,
  label,
  type,
}: {
  box: Box;
  label: string;
  type: "hover" | "selection";
}) {
  const isSelection = type === "selection";
  return (
    <div
      className={cn(
        "pointer-events-none absolute border",
        isSelection ? "border-primary bg-primary/5" : "border-primary/50",
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <span
        className={cn(
          "absolute -top-5 left-0 rounded px-1 text-[10px] leading-4 font-medium whitespace-nowrap",
          isSelection
            ? "bg-primary text-primary-foreground"
            : "bg-primary/80 text-primary-foreground",
        )}
      >
        {label}
      </span>
    </div>
  );
}

function SandboxPreviewSelectLayer({
  previewKey,
  selection,
  onSelect,
  onFramePick,
  busy,
  onSubmit,
}: {
  /** `previewRootKey(pin.id, variant.id)` — matched against the root attr. */
  previewKey: string;
  /** This variant's element selection (lifted state — the Escape ladder and
   * frame-pick exclusivity live in PageTools). */
  selection?: PreviewElementSelection;
  onSelect: (selection: PreviewElementSelection | undefined) => void;
  /** Click hit no preview element (card padding): frame-level pick fallback. */
  onFramePick?: () => void;
  /** The pin/variant already has a run in flight — submit disabled. */
  busy: boolean;
  /** Dispatch the iterate turn (prompt + element descriptor). */
  onSubmit: (
    prompt: string,
    element: SandboxIterateElementDescriptor,
  ) => Promise<{ error?: string }>;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const [hoverHit, setHoverHit] = useState<PageHit>();
  /** Last click point — Enter re-resolves the chain there to drill. */
  const lastPointRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  /** The pointer target inside THIS preview's subtree, plus the preview root
   * (the hit-test boundary). Undefined over padding/chrome. */
  function targetUnderPointer(
    x: number,
    y: number,
  ): { el: Element; root: Element } | undefined {
    const layer = layerRef.current;
    if (!layer) return undefined;
    const selector = `[${PREVIEW_ROOT_ATTR}="${previewKey}"]`;
    for (const el of elementsFromPointWithin(layer, x, y)) {
      const root = el.closest?.(selector);
      // The root itself (the measure wrapper) is not a selectable element —
      // treat it like padding so the frame fallback applies.
      if (root && root !== el) return { el, root };
    }
    return undefined;
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const { clientX, clientY } = event;
    const deep = event.metaKey || event.ctrlKey;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const target = targetUnderPointer(clientX, clientY);
      setHoverHit(
        target
          ? resolvePageHover(
              target.el,
              selectionRef.current?.drillPath ?? [],
              deep,
              target.root,
            )
          : undefined,
      );
    });
  }

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  function handleClick(event: ReactMouseEvent<HTMLDivElement>) {
    lastPointRef.current = { x: event.clientX, y: event.clientY };
    const target = targetUnderPointer(event.clientX, event.clientY);
    if (!target) {
      onFramePick?.();
      return;
    }
    const resolved =
      event.metaKey || event.ctrlKey
        ? resolvePageDeepClick(target.el, target.root)
        : resolvePageClick(
            target.el,
            selectionRef.current?.drillPath ?? [],
            target.root,
          );
    if (!resolved.hit) {
      onFramePick?.();
      return;
    }
    onSelect({ hit: resolved.hit, drillPath: resolved.drillPath });
  }

  /** Double-click (and Enter below): descend exactly one drillable level. */
  function drillAt(x: number, y: number): boolean {
    const target = targetUnderPointer(x, y);
    if (!target) return false;
    const resolved = resolvePageDoubleClick(
      target.el,
      selectionRef.current?.drillPath ?? [],
      target.root,
    );
    if (!resolved || !resolved.hit) return false;
    onSelect({ hit: resolved.hit, drillPath: resolved.drillPath });
    return true;
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    drillAt(event.clientX, event.clientY);
  }

  // Enter (selection present, not typing) drills one level — the keyboard
  // twin of double-click, scoped to this variant's selection. Capture phase
  // on window so the live app underneath never sees it; the PageTools ladder
  // only handles Enter for PAGE selections, so there is no double-handling.
  const hasSelection = selection !== undefined;
  useEffect(() => {
    if (!hasSelection) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || isEditableKeyTarget(event)) return;
      const point = lastPointRef.current;
      if (!point) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drillAt(point.x, point.y);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drillAt reads refs
  }, [hasSelection]);

  const layerRect = layerRef.current?.getBoundingClientRect();
  const layerBox = layerRect ? boxFromRect(layerRect) : undefined;
  const selectionBox =
    selection && layerBox
      ? relativeToLayer(currentHitRect(selection.hit), layerBox)
      : undefined;
  const showHover =
    hoverHit &&
    layerBox &&
    !(
      selection &&
      hoverHit.rect.x === selection.hit.rect.x &&
      hoverHit.rect.y === selection.hit.rect.y
    );

  return (
    <div
      ref={layerRef}
      className="absolute inset-0 z-20 cursor-crosshair"
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoverHit(undefined)}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {showHover ? (
        <PreviewOverlayBox
          box={relativeToLayer(hoverHit.rect, layerBox)}
          label={hoverHit.label}
          type="hover"
        />
      ) : null}
      {selection && selectionBox ? (
        <PreviewOverlayBox
          box={selectionBox}
          label={selection.hit.label}
          type="selection"
        />
      ) : null}
      {selection && layerBox ? (
        <PreviewElementPromptBox
          hit={selection.hit}
          position={anchoredPromptBoxPosition({
            rect: currentHitRect(selection.hit),
            layerRect: layerBox,
            boxWidth: PROMPT_BOX_WIDTH,
            boxHeight: PROMPT_BOX_HEIGHT,
          })}
          busy={busy}
          onSubmit={onSubmit}
          onDone={() => onSelect(undefined)}
        />
      ) : null}
    </div>
  );
}

/**
 * The compact anchored prompt box for a selected in-preview element: target
 * label (`div.flex`) + textarea, Return submits — the page prompt-first
 * pattern, but the submit is an ITERATE turn on this variant (element
 * descriptor attached), never a new pin.
 */
function PreviewElementPromptBox({
  hit,
  position,
  busy,
  onSubmit,
  onDone,
}: {
  hit: PageHit;
  position: { left: number; top: number };
  busy: boolean;
  onSubmit: (
    prompt: string,
    element: SandboxIterateElementDescriptor,
  ) => Promise<{ error?: string }>;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Prompt-first: selecting an element focuses the box (the page pattern).
  useEffect(() => {
    textareaRef.current?.focus();
  }, [hit]);

  async function submit() {
    const prompt = text.trim();
    if (!prompt || busy || submitting) return;
    setSubmitting(true);
    setError(undefined);
    const result = await onSubmit(prompt, descriptorFromHit(hit));
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setText("");
    onDone();
  }

  const style: CSSProperties = {
    left: position.left,
    top: position.top,
    width: PROMPT_BOX_WIDTH,
  };

  return (
    <div
      className="absolute z-30 grid cursor-default gap-1.5 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md"
      style={style}
      // The layer underneath owns select gestures — nothing from the box may
      // reach it (or, via bubbling, the app's shortcut handlers).
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate font-mono text-xs font-medium">
          {hit.label}
        </span>
        {busy || submitting ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
            <Spinner className="size-3" />
            {copy.working}
          </span>
        ) : null}
      </div>
      <Textarea
        ref={textareaRef}
        value={text}
        rows={2}
        placeholder={copy.placeholder}
        className="min-h-0 text-xs"
        disabled={busy || submitting}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export { PREVIEW_ROOT_ATTR, previewRootKey, SandboxPreviewSelectLayer };
export type { PreviewElementSelection };
