/**
 * Text-node hit-testing for the i18n text-edit tool.
 *
 * Scans DOM text nodes under the pointer for invisible i18n markers, returning
 * the marker entry and the bounding rect of the marked text node.
 */

import { decodeMarker, getMarkerEntry, type MarkerEntry } from "@designbook-ui/models/text/i18nMarkers";

type TextHitResult = {
  entry: MarkerEntry;
  markerIndex: number;
  textNode: Text;
  rect: DOMRect;
};

/**
 * Walk visible text nodes under `root` (or the element itself) and return the
 * first one whose textContent contains an i18n marker.
 */
function findMarkedTextNode(el: Element): TextHitResult | undefined {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent;
    if (text) {
      const index = decodeMarker(text);
      if (index !== undefined) {
        const entry = getMarkerEntry(index);
        if (entry) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { entry, markerIndex: index, textNode: node as Text, rect };
          }
        }
      }
    }
    node = walker.nextNode();
  }
  return undefined;
}

/**
 * Starting from the element at (clientX, clientY), walk up the DOM ancestors
 * looking for marked text nodes. Stops at `boundary` (the stage element).
 */
function textHitTest(
  startEl: Element,
  boundary: Element | null,
): TextHitResult | undefined {
  let current: Element | null = startEl;
  while (current && current !== boundary) {
    const hit = findMarkedTextNode(current);
    if (hit) return hit;
    current = current.parentElement;
  }
  return undefined;
}

export { findMarkedTextNode, textHitTest };
export type { TextHitResult };
