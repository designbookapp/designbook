/**
 * Element descriptor for an ITERATE turn (docs/specs/sandbox.md, canvas
 * element selection): when the designer selects an element INSIDE a rendered
 * variant preview and prompts, the iterate request carries a compact
 * description of that element — tag + classes, a trimmed outerHTML snippet
 * and the visible text — so the server-side prompt can say "the user selected
 * this element within the variant — apply the request to it".
 *
 * Pure trimming/assembly (unit-tested in the node env); the DOM-reading
 * wrapper that feeds it from a live selection lives in the screens layer
 * (SandboxPreviewSelect), keeping this module free of screens imports.
 */

/** Compact, size-capped description of one selected element. */
type SandboxIterateElementDescriptor = {
  /** Lowercase tag name ("div", "span"). */
  tag: string;
  /** DOM id, when present. */
  id?: string;
  /** Class list, capped. */
  classes?: string[];
  /** Chip-style label ("div.flex", "ProductPrice"). */
  label: string;
  /** Trimmed text content. */
  text?: string;
  /** Trimmed outerHTML snippet (≤ ~1KB). */
  outerHtml?: string;
  /** Registered component label when the selection IS a component level. */
  componentHint?: string;
};

/** Caps (client-side; the server re-clamps defensively). */
const DESCRIPTOR_MAX_OUTER_HTML = 1024;
const DESCRIPTOR_MAX_TEXT = 300;
const DESCRIPTOR_MAX_LABEL = 120;
const DESCRIPTOR_MAX_CLASSES = 12;

function trimTo(value: string, max: number): string {
  const collapsed = value.trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Assemble a descriptor from raw parts, applying the size caps. Whitespace in
 * `text` is collapsed (rendered text, not source formatting); `outerHtml` is
 * kept verbatim apart from the length cap so class/attribute boundaries stay
 * greppable in the variant source.
 */
function buildIterateElementDescriptor(parts: {
  tag: string;
  id?: string;
  classes?: readonly string[];
  label: string;
  text?: string;
  outerHtml?: string;
  componentHint?: string;
}): SandboxIterateElementDescriptor {
  const classes = (parts.classes ?? [])
    .filter(Boolean)
    .slice(0, DESCRIPTOR_MAX_CLASSES);
  const text = parts.text?.replace(/\s+/g, " ").trim();
  return {
    tag: parts.tag.toLowerCase(),
    ...(parts.id ? { id: parts.id } : {}),
    ...(classes.length > 0 ? { classes } : {}),
    label: trimTo(parts.label, DESCRIPTOR_MAX_LABEL),
    ...(text ? { text: trimTo(text, DESCRIPTOR_MAX_TEXT) } : {}),
    ...(parts.outerHtml
      ? { outerHtml: trimTo(parts.outerHtml, DESCRIPTOR_MAX_OUTER_HTML) }
      : {}),
    ...(parts.componentHint ? { componentHint: parts.componentHint } : {}),
  };
}

export {
  buildIterateElementDescriptor,
  DESCRIPTOR_MAX_OUTER_HTML,
  DESCRIPTOR_MAX_TEXT,
};
export type { SandboxIterateElementDescriptor };
