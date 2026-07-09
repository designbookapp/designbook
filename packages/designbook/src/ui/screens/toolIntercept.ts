/**
 * Capture-phase input interception for the select-style page/canvas tools.
 *
 * While a select tool is armed, its transparent overlay must intercept the
 * pointer FULLY: no app handler may fire from a selection click. A React
 * `onClick` on the overlay div is not enough, because the overlay's events
 * still propagate (composed) out of the workbench shadow root into the app's
 * document, where they trigger:
 *
 *   - document/window-level app listeners (Radix `DismissableLayer`'s
 *     `pointerdown` outside-dismiss, jQuery-style delegation, drag libraries,
 *     analytics) — in BOTH phases, and capture-phase ones run before any
 *     handler of ours that sits deeper in the tree;
 *   - apps that act on `pointerdown`/`mousedown` (fired long before our
 *     `click` handler);
 *   - default actions: focus moves (blur commits input edits), label-for
 *     activation, text selection.
 *
 * The only spot that beats an app's document-capture listener is a capture
 * listener on `window` (first node on the capture path). So while armed, the
 * overlay installs ONE capture-phase handler on its own window for the full
 * event sequence (`pointerdown` → … → `click`/`auxclick`/`dblclick`/
 * `contextmenu`). Events whose composed path hits the overlay layer are
 * swallowed there — `preventDefault()` + `stopImmediatePropagation()` — and
 * the tool's own logic runs directly from the interceptor (React never sees
 * these events, so the overlay drives selection from here, keeping the
 * coordinates/modifiers hit-testing needs). Events that hit interactive tool
 * chrome layered inside the overlay (`data-db-tool-ui`, e.g. the canvas
 * context menu) — or anything outside the overlay — pass through untouched.
 *
 * Middle-button `pointerdown`/`pointerup` also pass through: that's the
 * canvas-stage pan gesture, and it must keep reaching the stage while the
 * tool is armed. (`auxclick` itself is still swallowed, so the app never sees
 * a completed middle/right click.)
 *
 * The listener is attached to the LAYER's own window (`ownerDocument.
 * defaultView`), not the module-global one, so page tools mounted inside an
 * iframe'd app (nested flow screens included) intercept in the document the
 * app actually runs in.
 *
 * Guarded by `toolIntercept.test.ts`: pure-logic tests for the routing +
 * a source scan pinning capture-phase registration and the full event set.
 */

/** The full input sequence a selection click produces — every one of these is
 * swallowed while the pointer is over the armed overlay. */
const INTERCEPTED_TOOL_EVENTS = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
] as const;

type InterceptedToolEvent = (typeof INTERCEPTED_TOOL_EVENTS)[number];

/** Marks interactive tool chrome nested inside an overlay layer (context
 * menu, chip buttons): events there keep normal React propagation. */
const TOOL_UI_ATTR = "data-db-tool-ui";

/** What to do with an event, from its composed path (outermost target first):
 * "tool-ui" (chrome inside the overlay — leave alone), "intercept" (bare
 * overlay — swallow + run tool logic), or "pass" (not ours). */
type ToolInterceptVerdict = "pass" | "intercept" | "tool-ui";

/** Duck-typed path node so the pure logic is testable without a DOM. */
type PathNode = { hasAttribute?: (name: string) => boolean };

/**
 * Route an event by its composed path. The path is scanned from the target
 * outward; tool chrome is only honored INSIDE the layer (an app element with
 * a stray `data-db-tool-ui` outside the overlay can't opt out of anything —
 * outside the layer the verdict is "pass" regardless).
 */
function resolveToolIntercept(
  path: readonly PathNode[],
  layer: PathNode | null,
): ToolInterceptVerdict {
  if (!layer) return "pass";
  let toolUi = false;
  for (const node of path) {
    if (node === layer) return toolUi ? "tool-ui" : "intercept";
    if (node.hasAttribute?.(TOOL_UI_ATTR)) toolUi = true;
  }
  return "pass";
}

/** Middle-button press/release must keep reaching the canvas stage (pan). */
function passesForPan(event: MouseEvent): boolean {
  return (
    (event.type === "pointerdown" ||
      event.type === "pointerup" ||
      event.type === "mousedown" ||
      event.type === "mouseup") &&
    event.button === 1
  );
}

/**
 * Install the capture-phase interceptor for `layer` on the layer's own
 * window. `handlers` receives the swallowed events the tool cares about
 * (`click`, `dblclick`, `contextmenu`, …); all other intercepted events are
 * swallowed silently. Returns the uninstaller.
 */
function installToolIntercept(
  layer: HTMLElement,
  handlers: Partial<Record<InterceptedToolEvent, (event: MouseEvent) => void>>,
): () => void {
  const win = layer.ownerDocument?.defaultView ?? window;

  function onEvent(event: Event) {
    // Only the 8 mouse/pointer types above are registered, so the cast is
    // safe (and avoids cross-realm instanceof pitfalls for framed documents).
    const mouse = event as MouseEvent;
    if (passesForPan(mouse)) return;
    const path = event.composedPath() as readonly PathNode[];
    if (resolveToolIntercept(path, layer) !== "intercept") {
      return;
    }
    // Swallow the event completely BEFORE app handlers (document-capture ones
    // included — window-capture runs first) and before any default action
    // (focus change, label-for activation, native context menu).
    event.preventDefault();
    event.stopImmediatePropagation();
    handlers[event.type as InterceptedToolEvent]?.(mouse);
  }

  for (const type of INTERCEPTED_TOOL_EVENTS) {
    win.addEventListener(type, onEvent, { capture: true });
  }
  return () => {
    for (const type of INTERCEPTED_TOOL_EVENTS) {
      win.removeEventListener(type, onEvent, { capture: true });
    }
  };
}

export {
  INTERCEPTED_TOOL_EVENTS,
  TOOL_UI_ATTR,
  installToolIntercept,
  resolveToolIntercept,
};
export type { InterceptedToolEvent, ToolInterceptVerdict };
