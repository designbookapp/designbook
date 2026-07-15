/**
 * PreviewHost — the seam over all preview/document access (phase C2.4).
 *
 * Everything the workbench chrome needs to reach INTO the previewed document —
 * fiber hit-testing and drill-in, text-claim markers, the Figma serializer's
 * computed-style reads — funnels through this module. Today there is a single
 * **same-document** implementation: the workbench renders the components in its
 * own React tree, so "reaching into the preview" is direct DOM/fiber access,
 * and the functions re-exported below ARE that implementation (re-exported from
 * their `models/` homes — selection, text, catalog — not rewritten).
 *
 * The point of the seam is the future protocol line: a Model-A shell renders the
 * preview in a separate document (iframe / native surface) and implements the
 * same surface over `postMessage`. UI components must therefore depend ONLY on
 * this module, never on `fibers` directly — a unit test
 * (`previewHostSeam.test.ts`) greps `components/**` and fails if it happens.
 * (The Figma serializer itself moved into the figma integration plugin —
 * src/plugins/figma/ui/serialize.ts — and consumes THIS seam.)
 *
 * The `PreviewHost` interface below documents that surface as an object shape;
 * `sameDocumentPreviewHost` is the concrete binding. Existing call sites use the
 * named function re-exports (unchanged signatures); new/refactored code can take
 * a `PreviewHost` instead so it is transport-agnostic.
 */

import {
  getDomInstanceId,
  getFiberRects,
  getInstanceId,
  hitTest,
  hitTestChain,
  unionRects,
} from "./fibers";

// ---------------------------------------------------------------------------
// Same-document implementation surface — re-exported verbatim.
// ---------------------------------------------------------------------------

// Fiber hit-testing / geometry / instance identity.
export {
  collectSlotAwareSubtree,
  collectSubtree,
  getAnchorElement,
  getDomInstanceId,
  getFiberFromDom,
  getFiberProps,
  getFiberRects,
  getInstanceId,
  hitTest,
  hitTestChain,
  isElementNode,
  sourceFromFiber,
  unionRects,
  unwrapType,
} from "./fibers";
export type {
  BoundaryFiberNode,
  ComponentFiberEntry,
  DomFiberEntry,
  Fiber,
  FiberChainEntry,
  HitTestResult,
  SubtreeNode,
} from "./fibers";

// Host-app React Context reading (C4.3 host-context adapters).
export { readFiberContext } from "./fiberContext";

// Selection-context walkers (Info panel contributors — PREVIEW).
export { collectContextScope, collectRenderedText } from "./selectionInspect";
export type {
  ContextScopeEntry,
  RenderedTextEntry,
  RenderedTextResult,
} from "./selectionInspect";

// Same-origin iframe binding of the seam.
export {
  elementAtFramePoint,
  frameLocalRectToScreenRect,
  safeFrameDocument,
  safeFrameWindow,
} from "./framePreviewHost";
export {
  frameLocalBoxToScreenBox,
  frameScale,
  isFrameDocumentStale,
  isWithinFrameBounds,
  screenPointToFrameLocal,
} from "./frameCoords";
export type { Box as FrameBox, Point as FramePoint } from "./frameCoords";

// Selection drill-in over the fiber chain.
export {
  drillableIndices,
  resolveClickSelection,
  resolveDeepClick,
  resolveDoubleClick,
  resolveEscape,
} from "@designbook-ui/models/selection/drillSelection";
export type {
  ChainLink,
  ClickResolution,
  DeepClickResolution,
  DoubleClickResolution,
  EscapeResolution,
} from "@designbook-ui/models/selection/drillSelection";

// Mapping a selected node back to attributable source targets.
export {
  nearestComponentAncestor,
  resolveCodeTargets,
  resolveLevelOwner,
} from "@designbook-ui/models/selection/codeTargets";
export type { AttributableLink } from "@designbook-ui/models/selection/codeTargets";

// i18n text-claim markers (text tool ↔ serializer).
export {
  decodeMarker,
  getMarkerEntry,
  stripMarkers,
} from "@designbook-ui/models/text/i18nMarkers";
export type { MarkerEntry } from "@designbook-ui/models/text/i18nMarkers";

// ---------------------------------------------------------------------------
// Interface shape + same-document binding.
// ---------------------------------------------------------------------------

/**
 * The transport-agnostic contract for reaching into the previewed document.
 * The same-document binding is direct fiber/DOM access; a Model-A shell would
 * implement the same shape over a message channel. Method types are bound to
 * the same-document functions (`typeof`) so the interface never drifts from the
 * real surface it abstracts.
 */
interface PreviewHost {
  /** Hit-test the preview at an element, returning the component fiber under it. */
  hitTest: typeof hitTest;
  /** The full innermost→outermost fiber/DOM chain under an element. */
  hitTestChain: typeof hitTestChain;
  /** Stable instance id for a hit result (drill-in / selection identity). */
  getInstanceId: typeof getInstanceId;
  /** Instance id for a descendant DOM node within an owner instance. */
  getDomInstanceId: typeof getDomInstanceId;
  /** Bounding rects for a fiber's host nodes. */
  getFiberRects: typeof getFiberRects;
  /** Union of a set of rects (selection outline). */
  unionRects: typeof unionRects;
}

/** The current, same-document implementation of {@link PreviewHost}. */
const sameDocumentPreviewHost: PreviewHost = {
  hitTest,
  hitTestChain,
  getInstanceId,
  getDomInstanceId,
  getFiberRects,
  unionRects,
};

export { sameDocumentPreviewHost };
export type { PreviewHost };
