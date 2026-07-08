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
};

export type { CanvasCodeTarget, CanvasNodeSelection };
