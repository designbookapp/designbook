/**
 * Pure Figma-subtree → annotated-HTML mapping for the declarative "pull from
 * Figma" flow. The Figma plugin
 * (figma-plugin/readHtml.ts) walks the selected component's native nodes into
 * the lean `HtmlNode` shape below, then `htmlNodeToString` renders it to the
 * annotated HTML target handed to Pi.
 *
 * Annotations (all `data-*`) mark the DYNAMIC surfaces a designer can author —
 * content/prop slots, i18n text, token bindings, nested registered components,
 * list containers; unannotated nodes are static design. Concrete current values
 * ride through as element text (a SAMPLE for `data-slot`, the source of truth
 * for `data-i18n`).
 *
 * Framework-free (no React/DOM/Node) and ES2017-safe: compiled by the node/ui
 * tsconfigs AND by the Figma plugin's tsconfig.
 */

/** cssProperty → bound Figma variable name (e.g. `{ color: "color/primary" }`). */
type HtmlTokenMap = Record<string, string>;

/**
 * One node of the intermediate tree the plugin reads Figma into. Only the
 * fields the HTML emitter needs; geometry the differ used is gone.
 */
type HtmlNode = {
  /** Element tag. Defaults to `div` (`span` is set by the reader for text). */
  tag?: string;
  /** Content/prop slot name → `data-slot`. Text content is a SAMPLE. */
  slot?: string;
  /** i18n binding (`<ns>:<key>`) → `data-i18n`. Text is the current translation. */
  i18n?: string;
  /** Boolean show/hide slot name → `data-slot-if`. */
  slotIf?: string;
  /** A boolean-if slot currently hidden (adds the `hidden` attribute). */
  hidden?: boolean;
  /** Instance-swap slot name → `data-slot-swap` (emits no children). */
  slotSwap?: string;
  /** Nested registered component registry id → `data-component` (no children). */
  component?: string;
  /** `items[]` container → `data-list`; children are the item template. */
  list?: boolean;
  /** Variable bindings → `data-token-<cssProp>`. */
  tokens?: HtmlTokenMap;
  /** Concrete text content (escaped on emit). */
  text?: string;
  /** Literal inline CSS for static nodes → `style="…"`. */
  style?: Record<string, string>;
  /** Image source (emits `<img src=…>`, a void element). */
  src?: string;
  children?: HtmlNode[];
};

/** Escapes text content: `&`, `<`, `>`. */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes a double-quoted attribute value: `&`, `<`, `>`, `"`. */
function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

function attr(name: string, value: string): string {
  return `${name}="${escapeAttr(value)}"`;
}

/** Serializes an inline style object (`prop: value; …`), keys sorted. */
function styleString(style: Record<string, string>): string {
  return Object.keys(style)
    .sort()
    .map((prop) => `${prop}: ${style[prop]}`)
    .join("; ");
}

/**
 * The attribute list for a node, in a stable, human-legible order. A
 * `data-component` / `data-slot-swap` node is a bounded reference (no children);
 * everything else can carry children.
 */
function attributesOf(node: HtmlNode): string[] {
  const parts: string[] = [];
  if (node.list) parts.push("data-list");
  if (node.component !== undefined) parts.push(attr("data-component", node.component));
  if (node.slot !== undefined) parts.push(attr("data-slot", node.slot));
  if (node.i18n !== undefined) parts.push(attr("data-i18n", node.i18n));
  if (node.slotIf !== undefined) parts.push(attr("data-slot-if", node.slotIf));
  if (node.slotSwap !== undefined) parts.push(attr("data-slot-swap", node.slotSwap));
  if (node.tokens) {
    for (const prop of Object.keys(node.tokens).sort()) {
      parts.push(attr(`data-token-${prop}`, node.tokens[prop]));
    }
  }
  if (node.src !== undefined) parts.push(attr("src", node.src));
  if (node.style && Object.keys(node.style).length > 0) {
    parts.push(attr("style", styleString(node.style)));
  }
  if (node.hidden) parts.push("hidden");
  return parts;
}

/** `div` by default; the reader sets `span` for text and `img`/tag as needed. */
function tagOf(node: HtmlNode): string {
  return node.tag ?? "div";
}

/** A `data-component`/`data-slot-swap` node is a self-contained reference. */
function isReference(node: HtmlNode): boolean {
  return node.component !== undefined || node.slotSwap !== undefined;
}

function renderNode(node: HtmlNode, depth: number): string {
  const pad = "  ".repeat(depth);
  const tag = tagOf(node);
  const attrs = attributesOf(node);
  const open = attrs.length > 0 ? `${tag} ${attrs.join(" ")}` : tag;

  // Void element: <img …/>.
  if (tag === "img") return `${pad}<${open} />`;

  // Reference node (nested component / instance-swap): no children, no text.
  if (isReference(node)) return `${pad}<${open}></${tag}>`;

  const children = node.children ?? [];
  const text = node.text !== undefined ? escapeText(node.text) : "";

  // Leaf with text only, no element children: keep on one line.
  if (children.length === 0) {
    return `${pad}<${open}>${text}</${tag}>`;
  }

  const inner = children.map((child) => renderNode(child, depth + 1)).join("\n");
  // Text alongside children (rare) leads the block.
  const lead = text ? `${pad}  ${text}\n` : "";
  return `${pad}<${open}>\n${lead}${inner}\n${pad}</${tag}>`;
}

/** Renders an `HtmlNode` tree to the annotated HTML target string. */
function htmlNodeToString(root: HtmlNode): string {
  return renderNode(root, 0);
}

export { htmlNodeToString };
export type { HtmlNode, HtmlTokenMap };
