/**
 * A drilled selection's JSX usage site: the element's *owner* component (the
 * one whose render created it) plus the element's own name/className, so the
 * code panel can highlight the exact `<Card …>` / `<div …>` / `<ProductBadges
 * …>` line in the owner's source rather than the element's own definition.
 */
type CanvasCodeTarget = {
  /** Owner component's source path — the file to open. */
  file: string;
  /** Owner component's export name — where to start searching. */
  ownerExportName: string;
  /** The element's JSX name: a component name or a lowercase DOM tag. */
  name: string;
  kind: "component" | "dom";
  /** The element's className prop/attr, for disambiguating same-name tags. */
  className?: string;
};

/**
 * A COMPONENT hit's derived usage descriptor for the props panel, populated
 * when no `codeTarget` resolved — the outermost/undrilled selection
 * (`codeTargets.ts` intentionally leaves it undefined there so the code panel
 * shows the component's own definition, not a usage line). `ownerNames`
 * (nearest first) lets the server resolve the owning FILE via the same
 * bounded export scan the sandbox source-owner fallback uses, since no file
 * is resolvable client-side for a fresh click. `name` is the selected
 * component's own JSX name (the tag to locate in that file); `className` is
 * the value visible on the usage element via the fiber's `memoizedProps`,
 * when cheaply available.
 */
type CanvasUsageTarget = {
  ownerNames: string[];
  name: string;
  className?: string;
};

/** A canvas selection handed to the chat as prompt context. */
type CanvasNodeSelection = {
  description: string;
  /** The component's export name, e.g. "ProductCard". */
  exportName?: string;
  label: string;
  path: string;
  /** Set when the selection is a plain DOM node drilled into inside a
   * component (see CanvasOverlay's drill-in selection). `path`/`exportName`
   * still point at the owning component's source. */
  dom?: { tag: string; id?: string; classes?: string[] };
  /** Present for a drilled selection (any level below the outermost
   * component): highlights the element's JSX usage line in its owner's file
   * instead of the plain definition line. */
  codeTarget?: CanvasCodeTarget;
  /** Fallback usage-site descriptor for a COMPONENT hit with no `codeTarget`
   * (see `CanvasUsageTarget`) — lets the props panel still write to the JSX
   * call site via server-side owner-file resolution. */
  usage?: CanvasUsageTarget;
};

export type { CanvasCodeTarget, CanvasNodeSelection, CanvasUsageTarget };
