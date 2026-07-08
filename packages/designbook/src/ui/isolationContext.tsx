/**
 * Isolation seam for shadow-DOM mounting (phase C2.3).
 *
 * When the workbench is mounted with `isolation: "shadow"`, its chrome renders
 * INSIDE a shadow root (sealed from the host page's css) while the previewed
 * user components must render in the LIGHT DOM so the host page's stylesheets
 * reach them. This module carries the two DOM anchors that make that split work
 * down the tree without every consumer needing mount-time wiring:
 *
 *   - `portalContainer` — an element inside the shadow root that Radix portals
 *     (dropdown menus, selects, …) target instead of `document.body`, so their
 *     floating layers stay inside the shadow root and keep our chrome css.
 *   - `lightHost` — the shadow HOST element (which lives in the light DOM). A
 *     previewed component is portaled into a `<div slot=…>` appended here and
 *     projected back into a `<slot>` at its canvas position via native shadow
 *     slotting; slotted content is styled by the DOCUMENT, not the shadow root.
 *
 * In the default `isolation: "none"` mode both anchors are `null`, so every
 * consumer falls back to today's behavior (Radix → document.body, previews
 * render inline) with zero regression.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  acquirePageRootTokens,
  currentPageRootTokens,
  EMPTY_TOKENS,
} from "./pageRootTokens";

interface IsolationAnchors {
  /** Radix portal target inside the shadow root, or null in "none" mode. */
  portalContainer: HTMLElement | null;
  /** Shadow host (light DOM) that slotted preview content mounts into, or null. */
  lightHost: HTMLElement | null;
}

const IsolationContext = createContext<IsolationAnchors>({
  portalContainer: null,
  lightHost: null,
});

/** Provider set up by `mountWorkbench` with the resolved shadow anchors. */
function IsolationProvider({
  anchors,
  children,
}: {
  anchors: IsolationAnchors;
  children: ReactNode;
}) {
  return (
    <IsolationContext.Provider value={anchors}>
      {children}
    </IsolationContext.Provider>
  );
}

/**
 * Radix portal container. Returns the shadow-root element in shadow mode, or
 * `undefined` in "none" mode (Radix then defaults to `document.body`). Spread as
 * `container={usePortalContainer()}` onto a Radix `*.Portal`.
 */
function usePortalContainer(): HTMLElement | undefined {
  return useContext(IsolationContext).portalContainer ?? undefined;
}

/**
 * Subscribe to the page's root-level CSS custom properties (design tokens),
 * kept fresh by a shared observer. Active only when `enabled` (i.e. in shadow
 * isolation mode); returns an empty map otherwise so "none" mode does zero work.
 */
function usePageRootTokens(enabled: boolean): ReadonlyMap<string, string> {
  const [tokens, setTokens] = useState<ReadonlyMap<string, string>>(
    () => (enabled ? currentPageRootTokens() : EMPTY_TOKENS),
  );

  useEffect(() => {
    if (!enabled) return;
    // acquire() collects synchronously on the first mounted cell, then notifies
    // on every observed change; sync up now for later cells (cache already warm).
    const { release } = acquirePageRootTokens(() =>
      setTokens(currentPageRootTokens()),
    );
    setTokens(currentPageRootTokens());
    return release;
  }, [enabled]);

  return enabled ? tokens : EMPTY_TOKENS;
}

/**
 * Renders `children` in the LIGHT DOM when the workbench is shadow-mounted, at
 * the position this element occupies in the (shadow) canvas tree, via a native
 * `<slot>`. In "none" mode it is a transparent passthrough — `children` render
 * inline exactly as before.
 *
 * Slotted content is styled by the host page's stylesheets (not the shadow
 * root's), which is precisely what previewed user components need. Because
 * slotted elements inherit custom properties from the shadow flat tree (our
 * chrome), the page's `:root` design tokens are re-applied as inline styles on
 * the `<div slot=…>` wrapper — inline wins over the `::slotted` reset and over
 * flat-tree inheritance, so the cell sees the page's real token values.
 */
function LightDomSlot({ children }: { children: ReactNode }) {
  const { lightHost } = useContext(IsolationContext);
  // useId() contains colons; strip them for a clean slot/name attribute value.
  const slotName = `db-cell-${useId().replace(/:/g, "")}`;
  const pageTokens = usePageRootTokens(lightHost != null);

  if (!lightHost) return <>{children}</>;

  // Inline the page's root tokens onto the wrapper so they beat the chrome's
  // `::slotted` reset; tokens the page does NOT define stay unset and fall
  // through to that reset's `initial` (never the chrome value).
  const wrapperStyle: CSSProperties = { display: "contents" };
  for (const [name, value] of pageTokens) {
    (wrapperStyle as Record<string, string>)[name] = value;
  }

  return (
    <>
      {/* Slot placeholder at the canvas position (inside the shadow tree). */}
      {createElement("slot", { name: slotName, style: { display: "contents" } })}
      {/* Actual content projected from the light DOM into that slot. */}
      {createPortal(
        <div slot={slotName} style={wrapperStyle}>
          {children}
        </div>,
        lightHost,
      )}
    </>
  );
}

/**
 * `elementsFromPoint` against the tree `anchor` renders in. When the workbench
 * is shadow-mounted, `document.elementsFromPoint` does not pierce the shadow
 * root — it retargets everything (including slotted preview cells) to the
 * shadow HOST, so overlay hit-testing would only ever see the host page's DOM.
 * The shadow root's own `elementsFromPoint` returns the real inner→outer chain,
 * including slotted light-DOM content. In "none" mode this is exactly
 * `document.elementsFromPoint`.
 */
function elementsFromPointWithin(
  anchor: Element,
  clientX: number,
  clientY: number,
): Element[] {
  const rootNode = anchor.getRootNode();
  const doc = rootNode instanceof ShadowRoot ? rootNode : document;
  return doc.elementsFromPoint(clientX, clientY);
}

export {
  IsolationProvider,
  LightDomSlot,
  elementsFromPointWithin,
  usePortalContainer,
};
export type { IsolationAnchors };
