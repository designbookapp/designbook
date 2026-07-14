/**
 * Hover and selection overlay that renders measured rects from fiber hit-testing.
 * Rects are mapped from screen space to stage space by subtracting the stage
 * element's viewport offset, then subtracting pan, and dividing by scale.
 */

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { installToolIntercept } from "./toolIntercept";
import { cn } from "@designbook-ui/lib/utils";
import { elementsFromPointWithin } from "@designbook-ui/isolationContext";
import {
  hitTestChain,
  getAnchorElement,
  getDomInstanceId,
  getFiberRects,
  getInstanceId,
  unionRects,
  type Fiber,
  drillableIndices,
  resolveClickSelection,
  resolveDeepClick,
  resolveDoubleClick,
  resolveCodeTargets,
  resolveLevelOwner,
  type AttributableLink,
} from "@designbook-ui/previewHost";
import {
  elementAtDomPath,
  type SelectionSnapshot,
} from "@designbook-ui/workbenchPersist";
import {
  registryByRef,
  registryByName,
  type RegistryEntry,
} from "@designbook-ui/models/catalog/componentRegistry";
import { resolveSourceOwner } from "@designbook-ui/models/sandbox/sourceOwner";
import { useStageTransform, useStageElement } from "./stageContext";
import { CanvasContextMenu } from "@designbook-ui/components/CanvasContextMenu";
import type { CanvasCodeTarget } from "@designbook-ui/types";

type OverlayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DomHitInfo = { tag: string; id?: string; classes?: string[] };

type CanvasHitResult = {
  /** The component to associate with this hit. For a component hit it's the
   * component itself; for a DOM hit it's the component that *created* the node
   * (its `_debugOwner`) — so "Go to component" and chat/file context land in
   * the right file. */
  entry: RegistryEntry;
  rect: OverlayRect;
  instanceId: string;
  kind: "component" | "dom";
  /** The element's JSX name: component name or DOM tag. */
  name: string;
  /** Usage-line attribution — highlights the element's JSX site in its
   * owner's file when this hit is a drilled selection. */
  codeTarget?: CanvasCodeTarget;
  /** Set when this hit is a plain DOM node. */
  dom?: DomHitInfo;
  /**
   * Live anchor DOM element for this hit (the DOM node for a DOM hit, the
   * component's first host node otherwise). Non-serializable and transient —
   * used only to compute a durable `SelectionSnapshot` for reload rehydration
   *. Absent after a restore replay (the rect/selection still work).
   */
  anchor?: Element;
  /**
   * Live fiber for a component hit — feeds the Props panel's `memoizedProps`
   * read. Non-serializable and transient like `anchor`: absent for DOM hits
   * and after a restore replay (the panel degrades to metadata-only).
   */
  fiber?: Fiber;
  /**
   * How `entry` was derived: "entry" (default, a registered component) or
   * "source" — an UNREGISTERED authoring component resolved by the fiber
   * owner walk (sandbox owner fallback; `entry` is then a synthesized
   * entry-shaped identity with id "" and possibly sourcePath "").
   */
  ownerKind?: "entry" | "source";
  /** Named-owner chain, nearest first (source owners only — the pin route
   * resolves the file from it when sourcePath is ""). */
  ownerNames?: string[];
};

/** Figma-style css-ish label for a hit: the component label, or
 * `tag#id`/`tag.class`/`tag` for a DOM-level hit. */
function canvasHitLabel(hit: CanvasHitResult): string {
  if (!hit.dom) return hit.entry.label;
  const { tag, id, classes } = hit.dom;
  if (id) return `${tag}#${id}`;
  if (classes && classes.length > 0) return `${tag}.${classes[0]}`;
  return tag;
}

/** A DOMRect-shaped box — structural so callers that only have a plain object
 * (e.g. a frame-local rect already translated to screen space, see
 * `AppFrameOverlay.tsx`) don't need to construct a real `DOMRect`. */
type ScreenBox = { x: number; y: number; width: number; height: number };

function screenRectToStageRect(
  screenRect: ScreenBox,
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

function OverlayBox({
  label,
  rect,
  type,
}: {
  label?: string;
  rect: OverlayRect;
  type: "hover" | "selection";
}) {
  const isSelection = type === "selection";

  return (
    <div
      className={cn(
        "pointer-events-none absolute border",
        isSelection ? "border-primary bg-primary/5" : "border-primary/50",
      )}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }}
    >
      {label ? (
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
      ) : null}
    </div>
  );
}

type ChainItemBase = {
  instanceId: string;
  /** Associated component (see `CanvasHitResult.entry`). */
  entry: RegistryEntry;
  /** Registry id of the component whose JSX created this level — drives the
   * owner-filtered drill traversal (see drillSelection.ts). */
  ownerId?: string;
  codeTarget?: CanvasCodeTarget;
};

type ComponentChainItem = ChainItemBase & {
  kind: "component";
  /** The level's own registry id (drill traversal: "owned by S itself"). */
  componentId: string;
  fiber: Fiber;
  name: string;
};

type DomChainItem = ChainItemBase & {
  kind: "dom";
  element: Element;
  tag: string;
  id?: string;
  classes?: string[];
};

type ChainItem = ComponentChainItem | DomChainItem;

/**
 * Figma-style drill-in selection over the *interleaved* render tree:
 * `drillStack` is the stack of levels the user has entered (outermost first),
 * where a level is either a registered component or a plain host DOM element.
 * A click resolves to one level inside the deepest drilled ancestor found in
 * the chain under the pointer, or resets to the outermost match when the click
 * lands outside the drilled level entirely. Each double-click descends exactly
 * one level; a modifier+click drills straight to the innermost component
 * (holding Cmd/Ctrl previews that deep target in the hover highlight);
 * right-click opens a "Go to component" menu. See ./drillSelection.ts for the
 * pure resolution logic and ./fibers.ts for how the chain is built.
 */
function CanvasOverlay({
  drillStack,
  onDrillChange,
  onGoToComponent,
  onHover,
  onSelect,
  selectedHit,
  pendingRestore,
  onRestoreConsumed,
  elementAtPoint,
  rectToScreen,
  sourceOwnerFallback,
}: {
  drillStack: CanvasHitResult[];
  onDrillChange: (stack: CanvasHitResult[]) => void;
  /** Navigate to this hit's component page (and its definition in the code
   * tab) — the only way into a component's implementation. */
  onGoToComponent: (hit: CanvasHitResult) => void;
  onHover: (hit: CanvasHitResult | undefined) => void;
  onSelect: (hit: CanvasHitResult | undefined) => void;
  selectedHit: CanvasHitResult | undefined;
  /** A persisted selection to replay after the entry renders. */
  pendingRestore?: SelectionSnapshot;
  /** Called once the restore has been applied or given up on. */
  onRestoreConsumed?: () => void;
  /**
   * Resolve the element under a PARENT-screen point: overrides the default
   * same-document `elementsFromPointWithin` walk. `AppFrameOverlay` supplies a
   * frame-aware version that translates into the iframe's own document instead.
   */
  elementAtPoint?: (clientX: number, clientY: number) => Element | undefined;
  /**
   * Convert a rect measured against the hit element's OWN document into
   * parent-screen space before it's mapped into stage space: identity when
   * omitted (the same-document case, where a screen rect already IS parent-screen
   * space). `AppFrameOverlay` supplies the frame-local → screen conversion.
   */
  rectToScreen?: (rect: ScreenBox) => ScreenBox;
  /**
   * Owner fallback for DOM OUTSIDE any registered component (sandbox element
   * pins on page shells): when the chain is empty, a click selects the raw
   * element with its source-resolved authoring component as the owner.
   * Opt-in — ONLY the App-page frame sets it, where every element under the
   * pointer belongs to the user's app; on the same-document canvas an empty
   * chain means workbench chrome and must stay unselectable.
   */
  sourceOwnerFallback?: boolean;
}) {
  const transform = useStageTransform();
  const stageEl = useStageElement();
  const [hoverHit, setHoverHit] = useState<CanvasHitResult | undefined>();
  const [menu, setMenu] = useState<
    { x: number; y: number; hit: CanvasHitResult } | undefined
  >();
  const rootRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const lastInstanceIdRef = useRef<string>("");
  /** Last pointer position, so modifier keydown/keyup can re-resolve the
   * hover without any mouse movement. Cleared on pointer leave. */
  const lastPointerRef = useRef<{ x: number; y: number } | undefined>(
    undefined,
  );

  function elementUnderPointer(
    clientX: number,
    clientY: number,
  ): Element | undefined {
    if (elementAtPoint) return elementAtPoint(clientX, clientY);
    const root = rootRef.current;
    if (!root) return undefined;
    return elementsFromPointWithin(root, clientX, clientY).find(
      (el) => !root.contains(el),
    );
  }

  function toScreenBox(rect: ScreenBox): ScreenBox {
    return rectToScreen ? rectToScreen(rect) : rect;
  }

  /**
   * Interleaved chain under `el`, innermost first: the pointer-target DOM
   * element, then every registered component and host DOM element up to the
   * outermost registered component, each with a stable instanceId and its
   * owner-attributed codeTarget. Empty when the pointer isn't inside any
   * registered component. Code-target presence encodes drilled-ness: the
   * outermost level never has one (fresh click → definition), every deeper
   * level always does (drilled → usage line in the owner's file). See
   * ./codeTargets.ts for the pure attribution logic.
   */
  function resolveChain(el: Element): ChainItem[] {
    const fiberChain = hitTestChain(el, registryByRef, registryByName);
    if (fiberChain.length === 0) return [];

    const componentIds = fiberChain.map((entry) =>
      entry.kind === "component"
        ? getInstanceId({ entry: entry.entry, fiber: entry.fiber })
        : undefined,
    );

    function ancestorInstanceId(i: number): string {
      for (let j = i + 1; j < fiberChain.length; j++) {
        const id = componentIds[j];
        if (id) return id;
      }
      return "";
    }

    const links: AttributableLink[] = fiberChain.map((entry) => ({
      kind: entry.kind,
      entry: entry.kind === "component" ? entry.entry : undefined,
      ownerEntry: entry.ownerEntry,
      name: entry.kind === "component" ? entry.name : entry.tag,
      className: entry.className,
    }));
    const codeTargets = resolveCodeTargets(links);

    return fiberChain.map((entry, i): ChainItem => {
      if (entry.kind === "component") {
        return {
          kind: "component",
          instanceId: componentIds[i]!,
          entry: entry.entry,
          componentId: entry.entry.id,
          ownerId: entry.ownerEntry?.id,
          fiber: entry.fiber,
          name: entry.name,
          codeTarget: codeTargets[i],
        };
      }

      return {
        kind: "dom",
        instanceId: getDomInstanceId(entry.element, ancestorInstanceId(i)),
        // A DOM node's "component" is the one that created it (its owner),
        // falling back to the nearest registered chain ancestor — guaranteed
        // defined since the outermost chain level is a component.
        entry: resolveLevelOwner(links, i)!,
        ownerId: entry.ownerEntry?.id,
        element: entry.element,
        tag: entry.tag,
        id: entry.id,
        classes: entry.classes,
        codeTarget: codeTargets[i],
      };
    });
  }

  function toCanvasHit(item: ChainItem): CanvasHitResult | undefined {
    if (!stageEl) return undefined;

    if (item.kind === "dom") {
      const rect = screenRectToStageRect(
        toScreenBox(item.element.getBoundingClientRect()),
        stageEl,
        transform,
      );
      return {
        entry: item.entry,
        rect,
        instanceId: item.instanceId,
        kind: "dom",
        name: item.tag,
        codeTarget: item.codeTarget,
        dom: { tag: item.tag, id: item.id, classes: item.classes },
        anchor: item.element,
      };
    }

    const rects = getFiberRects(item.fiber);
    const union = unionRects(rects);
    if (!union) return undefined;

    const rect = screenRectToStageRect(toScreenBox(union), stageEl, transform);
    return {
      entry: item.entry,
      rect,
      instanceId: item.instanceId,
      kind: "component",
      name: item.name,
      codeTarget: item.codeTarget,
      anchor: getAnchorElement(item.fiber),
      fiber: item.fiber,
    };
  }

  /**
   * Owner-fallback hit for an element OUTSIDE any registered component
   * (empty chain): the raw DOM element with its source-resolved authoring
   * component synthesized as an entry-shaped owner (`ownerKind: "source"`,
   * sourceOwner.ts) — the sandbox prompt box's identity for page shells.
   * Undefined when the fallback is off (same-document canvas) or the element
   * has no named authoring component.
   */
  function sourceFallbackHit(el: Element): CanvasHitResult | undefined {
    if (!sourceOwnerFallback || !stageEl) return undefined;
    const owner = resolveSourceOwner(el);
    if (!owner) return undefined;
    const tag = el.tagName.toLowerCase();
    const rect = screenRectToStageRect(
      toScreenBox(el.getBoundingClientRect()),
      stageEl,
      transform,
    );
    const entry: RegistryEntry = {
      id: "",
      name: owner.name,
      label: owner.name,
      sourcePath: owner.sourcePath,
      component: undefined,
      exportName: owner.exportName,
      setId: "",
      key: owner.exportName,
    };
    return {
      entry,
      ownerKind: "source",
      ownerNames: owner.ownerNames,
      rect,
      instanceId: getDomInstanceId(el, `src:${owner.exportName}`),
      kind: "dom",
      name: tag,
      dom: {
        tag,
        id: el.id || undefined,
        classes: el.classList.length ? Array.from(el.classList) : undefined,
      },
      anchor: el,
    };
  }

  /** Rebuilds full drillStack entries from a resolved (outermost-first)
   * instanceId path, mapping each level back to its position on the chain's
   * *drillable* subsequence (skipped levels are never on a drill path). */
  function buildDrillStack(
    chain: ChainItem[],
    path: string[],
  ): CanvasHitResult[] {
    const outermostFirst = drillableIndices(chain).reverse();
    const stack: CanvasHitResult[] = [];
    for (let depth = 0; depth < path.length; depth++) {
      const chainIndex = outermostFirst[depth];
      if (chainIndex === undefined) break;
      const hit = toCanvasHit(chain[chainIndex]);
      if (hit) stack.push(hit);
    }
    return stack;
  }

  /**
   * Replays a persisted selection once the previewed entry has rendered.
   * The stored `SelectionSnapshot` is a structural DOM path from the entry's
   * `[data-db-entry]` root to the selected level's anchor element plus a drill
   * depth; we re-resolve the chain at that element and rebuild `selectedHit` +
   * `drillStack` exactly as a live click would. Returns false (retryable) when
   * the DOM/stage isn't ready yet, and silently drops (returns true, no
   * selection) when the component's shape changed — the entry/kind at the
   * derived depth no longer matches what was saved.
   */
  function restoreSelection(snapshot: SelectionSnapshot): boolean {
    if (!stageEl) return false;
    const root = document.querySelector(
      `[data-db-entry="${CSS.escape(snapshot.dbEntry)}"]`,
    );
    if (!root) return false; // entry not rendered yet — retry
    const anchor = elementAtDomPath(root, snapshot.domPath);
    if (!anchor) {
      onSelect(undefined);
      return true; // shape changed: the addressed node is gone — drop
    }
    const chain = resolveChain(anchor);
    if (chain.length === 0) {
      onSelect(undefined);
      return true;
    }
    const drillable = drillableIndices(chain);
    const position = drillable.length - 1 - snapshot.drillDepth;
    const chainIndex = drillable[position];
    const item = chainIndex === undefined ? undefined : chain[chainIndex];
    if (
      !item ||
      item.entry.id !== snapshot.entryId ||
      item.kind !== snapshot.kind
    ) {
      onSelect(undefined);
      return true; // shape drift at the saved depth — drop cleanly
    }
    const selected = toCanvasHit(item);
    if (!selected) return false; // rects not measurable yet — retry
    onSelect(selected);
    onDrillChange(
      buildDrillStack(chain, new Array(snapshot.drillDepth).fill("")),
    );
    return true;
  }

  const restoreRef = useRef(restoreSelection);
  restoreRef.current = restoreSelection;
  const onRestoreConsumedRef = useRef(onRestoreConsumed);
  onRestoreConsumedRef.current = onRestoreConsumed;

  useEffect(() => {
    if (!pendingRestore) return;
    let cancelled = false;
    let tries = 0;
    let raf = 0;
    function attempt() {
      if (cancelled) return;
      const done = restoreRef.current(pendingRestore!);
      if (done || tries++ >= 12) {
        onRestoreConsumedRef.current?.();
        return;
      }
      raf = requestAnimationFrame(attempt);
    }
    raf = requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one replay per pendingRestore
  }, [pendingRestore]);

  /**
   * Resolves and publishes the hover highlight at a pointer position. With
   * `deep` (Cmd/Ctrl held) it previews the deep-click target — the innermost
   * authored component `resolveDeepClick` would select — so users see where
   * a modifier+click will land before clicking; otherwise the normal click
   * resolution at the current drill depth.
   */
  function resolveHover(clientX: number, clientY: number, deep: boolean) {
    const target = elementUnderPointer(clientX, clientY);
    if (!target) {
      if (lastInstanceIdRef.current) {
        lastInstanceIdRef.current = "";
        setHoverHit(undefined);
        onHover(undefined);
      }
      return;
    }

    const chain = resolveChain(target);
    const index = deep
      ? resolveDeepClick(chain)?.index
      : resolveClickSelection(
          chain,
          drillStack.map((h) => h.instanceId),
        )?.index;
    const hit =
      index !== undefined
        ? toCanvasHit(chain[index])
        : chain.length === 0
          ? sourceFallbackHit(target)
          : undefined;
    const hitId = hit?.instanceId ?? "";

    if (hitId !== lastInstanceIdRef.current) {
      lastInstanceIdRef.current = hitId;
      setHoverHit(hit);
      onHover(hit);
    }
  }

  // Kept fresh so the stable modifier-key listeners (registered once below)
  // always call the latest closure (drillStack, stage transform, …).
  const resolveHoverRef = useRef(resolveHover);
  resolveHoverRef.current = resolveHover;

  // Re-resolve the hover immediately when Cmd/Ctrl is pressed or released
  // without any mouse movement, using the last known pointer position.
  // Mounted only while the select tool is active (this component's lifetime).
  useEffect(() => {
    function handleModifierKey(event: KeyboardEvent) {
      if (event.key !== "Meta" && event.key !== "Control") return;
      const pointer = lastPointerRef.current;
      if (!pointer) return;
      // On the modifier's own keyup, metaKey/ctrlKey already reflect the
      // released state — the OR stays true only if the other is still held.
      resolveHoverRef.current(
        pointer.x,
        pointer.y,
        event.metaKey || event.ctrlKey,
      );
    }
    window.addEventListener("keydown", handleModifierKey);
    window.addEventListener("keyup", handleModifierKey);
    return () => {
      window.removeEventListener("keydown", handleModifierKey);
      window.removeEventListener("keyup", handleModifierKey);
    };
  }, []);

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const { clientX, clientY } = event;
    const deep = event.metaKey || event.ctrlKey;
    lastPointerRef.current = { x: clientX, y: clientY };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() =>
      resolveHover(clientX, clientY, deep),
    );
  }

  function handlePointerLeave() {
    cancelAnimationFrame(rafRef.current);
    lastPointerRef.current = undefined;
    lastInstanceIdRef.current = "";
    setHoverHit(undefined);
    onHover(undefined);
  }

  // Selection handlers. Driven by the capture-phase interceptor (NOT React
  // synthetic events): `installToolIntercept` swallows the full pointer
  // sequence at the window before any app handler or default action can run,
  // then calls these with the native event (coordinates + modifiers intact).
  function handleClick(event: MouseEvent) {
    const target = elementUnderPointer(event.clientX, event.clientY);
    if (!target) {
      onSelect(undefined);
      if (drillStack.length > 0) onDrillChange([]);
      return;
    }

    const chain = resolveChain(target);

    // Owner fallback (empty chain — outside every registered component): the
    // raw element with its source-resolved authoring component, when armed.
    if (chain.length === 0) {
      onSelect(sourceFallbackHit(target));
      if (drillStack.length > 0) onDrillChange([]);
      return;
    }

    // Modifier+click: drill straight to the innermost component in one gesture.
    if (event.metaKey || event.ctrlKey) {
      const deep = resolveDeepClick(chain);
      if (!deep) {
        onSelect(undefined);
        if (drillStack.length > 0) onDrillChange([]);
        return;
      }
      onSelect(toCanvasHit(chain[deep.index]));
      onDrillChange(buildDrillStack(chain, deep.drillPath));
      return;
    }

    const currentDrillPath = drillStack.map((h) => h.instanceId);
    const resolved = resolveClickSelection(chain, currentDrillPath);
    if (!resolved) {
      onSelect(undefined);
      if (drillStack.length > 0) onDrillChange([]);
      return;
    }

    onSelect(toCanvasHit(chain[resolved.index]));
    // The resolved path is always a prefix of the current one — possibly
    // truncated to the common ancestor when the click diverged from the
    // drilled branch (or to [] on an unrelated chain). Truncate the stack to
    // match so double-click/Escape continue from the divergence level.
    if (resolved.drillPath.length !== drillStack.length) {
      onDrillChange(drillStack.slice(0, resolved.drillPath.length));
    }
  }

  function handleDoubleClick(event: MouseEvent) {
    const target = elementUnderPointer(event.clientX, event.clientY);
    if (!target) return;

    const chain = resolveChain(target);
    const currentDrillPath = drillStack.map((h) => h.instanceId);
    const resolved = resolveDoubleClick(chain, currentDrillPath);
    if (!resolved) return;

    // Leaf: the innermost level is already selected — nothing to do.
    if (resolved.kind === "leaf") return;

    onSelect(toCanvasHit(chain[resolved.index]));
    onDrillChange(buildDrillStack(chain, resolved.drillPath));
  }

  function handleContextMenu(event: MouseEvent) {
    // No preventDefault needed — the interceptor already cancelled the event.
    const target = elementUnderPointer(event.clientX, event.clientY);
    if (!target) {
      setMenu(undefined);
      return;
    }
    const chain = resolveChain(target);
    const currentDrillPath = drillStack.map((h) => h.instanceId);
    const resolved = resolveClickSelection(chain, currentDrillPath);
    const hit = resolved ? toCanvasHit(chain[resolved.index]) : undefined;
    // The menu only exists for registered custom-code components — plain DOM
    // levels have no definition of their own to go to.
    if (!hit || hit.kind !== "component") {
      setMenu(undefined);
      return;
    }
    onSelect(hit);
    setMenu({ x: event.clientX, y: event.clientY, hit });
  }

  // Latest-closure trampoline for the interceptor (installed once below):
  // the swallowed events must always reach the CURRENT handlers, which close
  // over live drillStack/transform/menu state.
  const interceptRef = useRef({
    handleClick,
    handleDoubleClick,
    handleContextMenu,
    closeMenu: () => setMenu(undefined),
  });
  interceptRef.current = {
    handleClick,
    handleDoubleClick,
    handleContextMenu,
    closeMenu: () => setMenu(undefined),
  };

  // Full capture-phase interception while the select tool is armed (this
  // component's lifetime): NO app handler may fire from a selection click —
  // see toolIntercept.ts for the leak vectors this closes. The tool's own
  // click/dblclick/contextmenu logic runs from the interceptor instead of
  // React (the swallowed events never reach React's root listeners).
  useEffect(() => {
    const layer = rootRef.current;
    if (!layer) return;
    return installToolIntercept(layer, {
      // A press on the bare overlay dismisses an open context menu — the
      // menu's own outside-pointerdown dismissal can't see swallowed events.
      pointerdown: () => interceptRef.current.closeMenu(),
      click: (event) => interceptRef.current.handleClick(event),
      dblclick: (event) => interceptRef.current.handleDoubleClick(event),
      contextmenu: (event) => interceptRef.current.handleContextMenu(event),
    });
  }, []);

  const showHover = hoverHit && hoverHit.instanceId !== selectedHit?.instanceId;

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-10"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={{ pointerEvents: "auto", cursor: "default" }}
    >
      <div
        className="pointer-events-none absolute origin-top-left"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
        }}
      >
        {showHover ? (
          <OverlayBox
            rect={hoverHit.rect}
            label={canvasHitLabel(hoverHit)}
            type="hover"
          />
        ) : null}
        {selectedHit ? (
          <OverlayBox
            rect={selectedHit.rect}
            label={canvasHitLabel(selectedHit)}
            type="selection"
          />
        ) : null}
      </div>
      {menu ? (
        <CanvasContextMenu
          x={menu.x}
          y={menu.y}
          onGoToComponent={() => onGoToComponent(menu.hit)}
          onClose={() => setMenu(undefined)}
        />
      ) : null}
    </div>
  );
}

export { CanvasOverlay, canvasHitLabel, screenRectToStageRect };
export type { CanvasHitResult, OverlayRect, ScreenBox };
