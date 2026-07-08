/**
 * The `frame` model — the App page's live-iframe state + the pure route/hit
 * operations its surfaces share.
 *
 * The App page shows the running app in a same-origin `<iframe>`; its tool
 * overlays (select/text) reach that iframe element — a SIBLING of `AppPage` in
 * the tree, not a descendant — through this model's context (the reason the old
 * `AppFrameContext` existed). This model bundles that live handle with the pure
 * route helpers (`buildFrameSrc`/`normalizeAppPath`/`stripFrameParam`) and the
 * pure frame-hit helpers (`buildFramePromptPrefill`/`canGoToFrameComponent`) so
 * the surfaces consume ONE thing.
 *
 * ## Altitude
 * The frame now OWNS its live state: `FrameProvider` (live mode) holds the
 * iframe element + generation counter + the `ignoreNextNavigation` latch and
 * reads the catalog route's `navigateApp` for `open` — none of it is injected
 * from `Workbench` anymore. This model is still a pure factory: it carries the
 * handle values + the actions the provider supplies (`open`,
 * `ignoreNextNavigation`, `setIframe`, `notifyNavigated`) plus the pure route/
 * hit helpers. The DOM/iframe-bound helpers (`appFrameHit`, `appFrameMark`,
 * `appFrameFlush`) stay in their own modules — surfaces invoke them directly.
 *
 * `notifyNavigated` bumps the generation and consumes the reload latch; the
 * TOOL/SELECTION reset it triggers on a real navigation stays in `Workbench`
 * (that state isn't frame-owned), reached through the provider's injected
 * `onFrameNavigated` callback — a genuine tool-state seam.
 *
 * `createFrameModel` is a pure factory (no React, no globals): live use feeds
 * the iframe handle as `data` + the bound actions; fixture/cell/test use feeds
 * canonical `data` and the actions default to no-ops.
 */

import {
  DEFAULT_APP_PATH,
  buildFrameSrc,
  normalizeAppPath,
  stripFrameParam,
} from "./appFrame";
import { buildFramePromptPrefill, canGoToFrameComponent } from "./appFrameHit";

/** The live iframe handle (from `Workbench`), or a fixture stand-in. */
type FrameData = {
  /** The live `<iframe>` element, or null before mount / after unmount. */
  iframe: HTMLIFrameElement | null;
  /**
   * Increments on every frame `load` after the first (reload or full in-frame
   * navigation) — surfaces drop hover/edit state resolved against a document
   * that no longer exists.
   */
  generation: number;
  /** The route the App page is showing (normalized), for display/atoms. */
  path: string;
};

/** Navigate the App page to a workbench-relative path. Live: the provider wires
 * this to the catalog route's `navigateApp`; a no-op in fixture/cell mode. */
type FrameOpen = (path: string) => void;

/** The frame model surface exposed on context and returned by the factory. */
type FrameModel = FrameData & {
  /** Navigate the App page to a path. */
  open: FrameOpen;
  /** Latch the next self-triggered reload as a rewire, not a real navigation. */
  ignoreNextNavigation: () => void;
  /** Report the live `<iframe>` element (or null on unmount). Live: the App
   * page calls this on ref mount/remount; a no-op in fixture/cell mode. */
  setIframe: (iframe: HTMLIFrameElement | null) => void;
  /** Report a frame `load`: bump the generation, consume the reload latch,
   * and (on a real navigation) reset the active tool. No-op in fixture mode. */
  notifyNavigated: () => void;
  // Pure route ops (shared by the App page + its overlays).
  buildFrameSrc: typeof buildFrameSrc;
  normalizeAppPath: typeof normalizeAppPath;
  stripFrameParam: typeof stripFrameParam;
  /** Route the App page shows on a direct visit (not via expand-from-strip). */
  defaultPath: string;
  // Pure frame-hit ops (shared by the select overlay + the prompt handoff).
  buildPromptPrefill: typeof buildFramePromptPrefill;
  canGoToComponent: typeof canGoToFrameComponent;
};

type CreateFrameModelOptions = {
  /** The live/fixture iframe handle; omitted defaults to an empty handle. */
  data?: FrameData;
  /** Live navigate action; omitted in fixture/cell mode (no-op). */
  open?: FrameOpen;
  /** Live reload latch; omitted in fixture/cell mode (no-op). */
  ignoreNextNavigation?: () => void;
  /** Live iframe-element reporter; omitted in fixture/cell mode (no-op). */
  setIframe?: (iframe: HTMLIFrameElement | null) => void;
  /** Live frame-load reporter; omitted in fixture/cell mode (no-op). */
  notifyNavigated?: () => void;
};

const EMPTY_DATA: FrameData = {
  iframe: null,
  generation: 0,
  path: DEFAULT_APP_PATH,
};

const noop = () => {};

/**
 * Build a frame model. Pure — no React, no globals. See the module doc for the
 * live (handle-fed) vs. fixture split.
 */
function createFrameModel(options: CreateFrameModelOptions = {}): FrameModel {
  const data = options.data ?? EMPTY_DATA;
  return {
    ...data,
    open: options.open ?? noop,
    ignoreNextNavigation: options.ignoreNextNavigation ?? noop,
    setIframe: options.setIframe ?? noop,
    notifyNavigated: options.notifyNavigated ?? noop,
    buildFrameSrc,
    normalizeAppPath,
    stripFrameParam,
    defaultPath: DEFAULT_APP_PATH,
    buildPromptPrefill: buildFramePromptPrefill,
    canGoToComponent: canGoToFrameComponent,
  };
}

export { createFrameModel };
export type { CreateFrameModelOptions, FrameData, FrameModel, FrameOpen };
