/**
 * Serializes the component rendered on the canvas into a `RenderTree` (see
 * config/figmaRender.ts) for the "push to Figma" flow. Walks the live DOM
 * under the preview root, mapping computed styles through the pure
 * `flexToLayout`/`styleToVisuals` mappers, and uses the React fiber tree to
 * detect nested REGISTERED components. Components that receive parent-authored
 * (slotted) children serialize INLINE as plain frames marked with
 * `slotComponentId` (Figma kind:"slot" frames, diffable at this level); the
 * rest become `childComponent` placeholder nodes (Figma instances) plus one
 * fully-serialized tree per component (the Figma COMPONENT main).
 *
 * Canvas-zoom correction: `getComputedStyle` values are layout px (transforms
 * don't affect them) but `getBoundingClientRect` IS scaled by the canvas zoom
 * transform, so every rect is divided by the measured scale ratio.
 */

import {
  blockStackGap,
  decideTextSizing,
  flexToLayout,
  hashRenderTree,
  parseCssColor,
  styleToVisuals,
  type RenderLayout,
  type RenderNode,
  type RenderOccurrence,
  type RenderTree,
  type Rgba,
  type StyleRecord,
} from "@designbookapp/designbook/config";
import { getFigmaTokenSource } from "@designbook-ui/adapterRuntime";
import {
  collectSlotAwareSubtree,
  collectSubtree,
  getFiberFromDom,
  getFiberProps,
  type Fiber,
} from "./fibers";
import { registryByName, registryByRef } from "@designbook-ui/models/catalog/componentRegistry";
import { decodeMarker, getMarkerEntry, stripMarkers } from "@designbook-ui/models/text/i18nMarkers";
import { CANVAS_THEME_CLASS } from "@designbook-ui/models/configState/themeConstants";

const MAX_IMAGE_EDGE = 1024;
/** Per-image base64 cap (~1MB of encoded data). */
const MAX_IMAGE_BASE64_CHARS = 1_400_000;
/** Whole-tree JSON cap. */
const MAX_TREE_BYTES = 10 * 1024 * 1024;
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const PLACEHOLDER_GRAY: Rgba = { r: 0.8, g: 0.8, b: 0.8, a: 1 };

type Rect = { x: number; y: number; width: number; height: number };

type SerializeOptions = {
  componentId: string;
  componentName: string;
  meta: {
    locale: string;
    variant: string;
    mode: string;
    collection?: string;
    /** OTHER active adapter dimension values (flags etc.), id -> value. */
    dimensions?: Record<string, string>;
  };
};

type SerializeResult = { tree: RenderTree; warnings: string[] };

/** One nested-component occurrence found via the fiber tree. */
type BoundaryOccurrence = {
  entryId: string;
  entryName: string;
  occurrenceIndex: number;
  hostRoots: Element[];
  /**
   * True when the component receives parent-authored (slotted) content: its
   * subtree is serialized INLINE as a plain frame stamped kind:"slot" instead
   * of a COMPONENT main + opaque INSTANCE, so slot internals stay diffable at
   * this level.
   */
  slot: boolean;
};

type TokenMaps = {
  colorByRgb: Map<string, string>;
  dimByPx: Map<number, string>;
};

type WalkContext = {
  scaleInv: number;
  tokens: TokenMaps;
  warnings: string[];
  images: Record<string, { base64: string; mime: string }>;
  imageIdByUrl: Map<string, string | undefined>;
  /** Element → occurrence; empty while serializing inside a child tree. */
  boundary: Map<Element, BoundaryOccurrence>;
  onOccurrence?: (occurrence: BoundaryOccurrence, dbId: string, layout: RenderLayout) => void;
  /** Text-diff passes skip image embedding (the tree is discarded). */
  skipImages?: boolean;
};

function rgbaKey(color: Rgba): string {
  const q = (value: number) => Math.round(value * 255);
  return `${q(color.r)},${q(color.g)},${q(color.b)},${Math.round(color.a * 1000)}`;
}

/** Computed style → plain record of the properties the mappers read. */
const STYLE_PROPS = [
  "display",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "column-gap",
  "row-gap",
  "justify-content",
  "align-items",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "background-color",
  "background-image",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "box-shadow",
  "opacity",
  "overflow",
  "position",
] as const;

function styleRecord(style: CSSStyleDeclaration): StyleRecord {
  const record: StyleRecord = {};
  for (const prop of STYLE_PROPS) {
    record[prop] = style.getPropertyValue(prop);
  }
  return record;
}

function scaleRect(rect: DOMRect, scaleInv: number): Rect {
  return {
    x: rect.x * scaleInv,
    y: rect.y * scaleInv,
    width: rect.width * scaleInv,
    height: rect.height * scaleInv,
  };
}

function unionRects(rects: Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** True when `value` contains at least one React element/portal. */
function containsReactElement(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReactElement);
  return (
    typeof value === "object" &&
    value !== null &&
    "$$typeof" in (value as Record<string, unknown>)
  );
}

/**
 * Slot heuristic: the component receives element/portal `children` from its
 * parent (e.g. `<Card>…</Card>` in ProductCard) — its rendered content is
 * authored by the parent, so a COMPONENT main would freeze parent content
 * into the child. String/number children (a Button label) are NOT slots:
 * instance text overrides already handle those.
 */
function isSlotFiber(fiber: Fiber): boolean {
  return containsReactElement(getFiberProps(fiber).children);
}

/** First host DOM elements (document order) under a fiber, one per branch. */
function collectHostRoots(fiber: Fiber): Element[] {
  const roots: Element[] = [];
  function walk(node: Fiber) {
    if (node.tag === 4 /* HostPortal */) return;
    if (node.stateNode instanceof Element) {
      roots.push(node.stateNode);
      return;
    }
    let child = node.child;
    while (child) {
      walk(child);
      child = child.sibling;
    }
  }
  walk(fiber);
  return roots;
}

/** CSS length string → px (rem resolved against the document root). */
function cssLengthToPx(raw: string): number | undefined {
  const text = raw.trim();
  const match = /^(-?[\d.]+)(px|rem|em)?$/.exec(text);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;
  if (match[2] === "rem" || match[2] === "em") {
    const rootSize =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
      16;
    return value * rootSize;
  }
  return value;
}

/**
 * Probes the registered theme-token source (see adapterRuntime's
 * `setFigmaTokenSource`) against the live canvas theme element: each color
 * token's CSS var is resolved to its computed rgb inside a hidden probe, each
 * dimension token to px. Collisions keep the FIRST token in model order.
 */
function buildTokenMaps(rootEl: Element): TokenMaps {
  const maps: TokenMaps = { colorByRgb: new Map(), dimByPx: new Map() };
  const source = getFigmaTokenSource();
  if (!source || source.tokens.length === 0) return maps;

  const themeEl = rootEl.closest(`.${CANVAS_THEME_CLASS}`) ?? rootEl;
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  themeEl.appendChild(probe);
  try {
    const themeStyle = getComputedStyle(themeEl);
    for (const token of source.tokens) {
      const rawValue = themeStyle.getPropertyValue(`--${token.cssVar}`).trim();
      // Derived tokens (token.cssValue, e.g. the radius scale from the
      // `@theme` block) may have no custom property in the document at all.
      if (rawValue === "" && !token.cssValue) continue;

      if (token.type === "color") {
        if (rawValue === "") continue;
        probe.style.color = `var(--${token.cssVar})`;
        const computed = getComputedStyle(probe).color;
        const rgba = parseCssColor(computed);
        if (rgba) {
          const key = rgbaKey(rgba);
          if (!maps.colorByRgb.has(key)) {
            maps.colorByRgb.set(key, token.figmaName);
          }
        }
      } else if (token.type === "dimension") {
        // Fast path: a plain length. calc()/var() expressions (the radius
        // scale: `calc(var(--radius) * 1.4)`) resolve through a width probe —
        // the computed width of an absolute-length calc() is a px value.
        let px = rawValue !== "" ? cssLengthToPx(rawValue) : undefined;
        if (px === undefined) {
          probe.style.width = "";
          probe.style.width = rawValue !== "" ? rawValue : token.cssValue!;
          px = cssLengthToPx(getComputedStyle(probe).width);
        }
        if (px !== undefined) {
          px = Math.round(px * 100) / 100; // match the serializer's round2
          if (!maps.dimByPx.has(px)) maps.dimByPx.set(px, token.figmaName);
        }
      }
    }
  } finally {
    probe.remove();
  }
  return maps;
}

function attachTokens(node: RenderNode, tokens: TokenMaps): void {
  if (node.fills) {
    for (const fill of node.fills) {
      if (fill.kind === "solid") {
        const token = tokens.colorByRgb.get(rgbaKey(fill.color));
        if (token) fill.tokenName = token;
      }
    }
  }
  if (node.stroke) {
    const token = tokens.colorByRgb.get(rgbaKey(node.stroke.color));
    if (token) node.stroke.tokenName = token;
  }
  if (typeof node.cornerRadius === "number") {
    const token = tokens.dimByPx.get(node.cornerRadius);
    if (token) node.radiusToken = token;
  }
  if (node.layout.gap !== undefined) {
    const token = tokens.dimByPx.get(node.layout.gap);
    if (token) node.gapToken = token;
  }
  if (node.text) {
    const token = tokens.colorByRgb.get(rgbaKey(node.text.color));
    if (token) node.text.colorToken = token;
  }
}

function firstFontFamily(fontFamily: string): string {
  const first = fontFamily.split(",")[0] ?? "";
  return first.trim().replace(/^["']|["']$/g, "") || "Inter";
}

function mapTextAlign(textAlign: string): "left" | "center" | "right" | "justified" {
  switch (textAlign) {
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "justify":
      return "justified";
    default:
      return "left";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function frameName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const firstClass = el.classList.item(0);
  return firstClass ? `${tag}.${truncate(firstClass, 24)}` : tag;
}

/** Serializes an inline `<svg>` with computed presentation inlined. */
function serializeSvg(el: SVGSVGElement, rect: Rect): string {
  const clone = el.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("width", String(round2(rect.width)));
  clone.setAttribute("height", String(round2(rect.height)));

  const computed = getComputedStyle(el);
  if (!clone.getAttribute("fill") && computed.fill && computed.fill !== "none") {
    clone.setAttribute("fill", computed.fill);
  }
  if (
    !clone.getAttribute("stroke") &&
    computed.stroke &&
    computed.stroke !== "none"
  ) {
    clone.setAttribute("stroke", computed.stroke);
  }

  // `currentColor` doesn't survive extraction from the document; bake in the
  // element's computed color.
  return clone.outerHTML.split("currentColor").join(computed.color || "black");
}

/** Fetches + downscales a same-origin image to a PNG data payload. */
async function encodeImage(
  url: string,
  ctx: WalkContext,
): Promise<string | undefined> {
  if (ctx.skipImages) return undefined;
  if (ctx.imageIdByUrl.has(url)) return ctx.imageIdByUrl.get(url);

  let imageId: string | undefined;
  try {
    const resolved = new URL(url, window.location.href);
    if (resolved.origin !== window.location.origin) {
      throw new Error(`cross-origin image skipped: ${url}`);
    }
    const response = await fetch(resolved.href);
    if (!response.ok) throw new Error(`fetch failed (${response.status})`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const longEdge = Math.max(bitmap.width, bitmap.height);
    const ratio = longEdge > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longEdge : 1;
    const width = Math.max(1, Math.round(bitmap.width * ratio));
    const height = Math.max(1, Math.round(bitmap.height * ratio));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d canvas context");
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (base64.length > MAX_IMAGE_BASE64_CHARS) {
      throw new Error(`image too large after downscale: ${url}`);
    }

    imageId = `img${Object.keys(ctx.images).length}`;
    ctx.images[imageId] = { base64, mime: "image/png" };
  } catch (error) {
    ctx.warnings.push(
      `Image could not be embedded (${error instanceof Error ? error.message : String(error)}); used a gray placeholder.`,
    );
    imageId = undefined;
  }

  ctx.imageIdByUrl.set(url, imageId);
  return imageId;
}

function extractBackgroundImageUrl(backgroundImage: string): string | undefined {
  const match = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(backgroundImage);
  return match ? match[1] : undefined;
}

/**
 * True when the element's rendered height is CONTENT-DETERMINED: forcing
 * `height: auto` (inline, !important — beats utility classes) does not change
 * the measured height. The toggle + restore is fully synchronous, so the
 * browser never paints the intermediate state — the live preview cannot
 * flash; only layout is (briefly) recomputed. Both rects share the canvas
 * zoom scale, so the comparison needs no correction.
 */
function isContentHeight(el: HTMLElement): boolean {
  const inline = el.style;
  const prevHeight = inline.getPropertyValue("height");
  const prevHeightPriority = inline.getPropertyPriority("height");
  const prevTransition = inline.getPropertyValue("transition");
  const prevTransitionPriority = inline.getPropertyPriority("transition");
  const before = el.getBoundingClientRect().height;
  // A CSS height transition would report the OLD height right after the
  // toggle (progress 0) and fake a content-determined result — disable it.
  inline.setProperty("transition", "none", "important");
  inline.setProperty("height", "auto", "important");
  const after = el.getBoundingClientRect().height;
  if (prevHeight !== "") {
    inline.setProperty("height", prevHeight, prevHeightPriority);
  } else {
    inline.removeProperty("height");
  }
  if (prevTransition !== "") {
    inline.setProperty("transition", prevTransition, prevTransitionPriority);
  } else {
    inline.removeProperty("transition");
  }
  return Math.abs(after - before) < 0.6;
}

/**
 * Upgrades a NON-FLEX container to VERTICAL autolayout when its in-flow
 * children form a clean full-width block stack (see `blockStackGap` for the
 * exact shape). Absolute/hidden children are excluded (they ride along as
 * `layout.absolute` nodes); direct text or inline/float children keep the
 * container mode:"none". Needed because Figma NONE frames can neither HUG
 * nor host `layoutPositioning: "ABSOLUTE"` children — this is what lets the
 * ProductCard image+badges wrapper round-trip with no fixed height.
 */
function upgradeBlockStack(
  el: Element,
  layout: RenderLayout,
  rect: Rect,
  scaleInv: number,
): void {
  for (const child of Array.from(el.childNodes)) {
    if (
      child.nodeType === Node.TEXT_NODE &&
      stripMarkers(child.textContent ?? "").trim() !== ""
    ) {
      return; // direct text participates in inline flow, not a stack
    }
  }
  const inflow: Rect[] = [];
  for (const child of Array.from(el.children)) {
    if (SKIPPED_TAGS.has(child.tagName)) continue;
    const childStyle = getComputedStyle(child);
    if (childStyle.display === "none" || childStyle.visibility === "hidden") {
      continue;
    }
    if (childStyle.position === "absolute" || childStyle.position === "fixed") {
      continue; // out of flow — becomes a layoutPositioning ABSOLUTE child
    }
    if (childStyle.display.indexOf("inline") === 0) return;
    const cssFloat = childStyle.getPropertyValue("float");
    if (cssFloat !== "" && cssFloat !== "none") return;
    inflow.push(scaleRect(child.getBoundingClientRect(), scaleInv));
  }
  const stack = blockStackGap(inflow, layout.padding, rect);
  if (!stack) return;
  layout.mode = "vertical";
  if (stack.gap > 0) layout.gap = stack.gap;
  layout.primaryAlign = "min";
  // The full-width check verified block children fill the container — CSS
  // default stretch, which the pull collapses back to implicit.
  layout.counterAlign = "stretch";
}

/** Safety factor for FIXED multi-line text boxes (Figma metrics run wider). */
const TEXT_WIDTH_PAD = 1.02;

function serializeTextNode(
  textNode: Text,
  parentStyle: CSSStyleDeclaration,
  dbId: string,
  parentRect: Rect,
  parentMode: RenderLayout["mode"],
  ctx: WalkContext,
): RenderNode | null {
  const raw = textNode.textContent ?? "";
  const characters = stripMarkers(raw).replace(/\s+/g, " ").trim();
  if (characters === "") return null;

  const range = document.createRange();
  range.selectNodeContents(textNode);
  const rect = scaleRect(range.getBoundingClientRect(), ctx.scaleInv);
  range.detach();
  if (rect.width === 0 && rect.height === 0) return null;

  const markerIndex = decodeMarker(raw);
  const markerEntry =
    markerIndex === undefined ? undefined : getMarkerEntry(markerIndex);

  const lineHeight = Number.parseFloat(parentStyle.lineHeight);
  const letterSpacing = Number.parseFloat(parentStyle.letterSpacing);
  const color = parseCssColor(parentStyle.color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const fontSize = Number.parseFloat(parentStyle.fontSize) || 16;

  const sizing = decideTextSizing(
    rect.height,
    fontSize,
    Number.isFinite(lineHeight) ? lineHeight : undefined,
    parentMode,
  );

  // Multi-line text in a mode:"none" parent keeps a FIXED wrapping box: the
  // parent's available content width when it is wider than the measured text
  // (that IS the browser's wrapping box), otherwise the measured width padded
  // for Figma's wider font metrics.
  let width = round2(rect.width);
  if (!sizing.autoWidth && !sizing.fillWidth) {
    const paddingRight = Number.parseFloat(parentStyle.paddingRight) || 0;
    const available =
      parentRect.width - (rect.x - parentRect.x) - paddingRight;
    width = round2(Math.max(rect.width * TEXT_WIDTH_PAD, available));
  }

  const node: RenderNode = {
    dbId,
    type: "text",
    name: truncate(characters, 40),
    layout: {
      mode: "none",
      x: round2(rect.x - parentRect.x),
      y: round2(rect.y - parentRect.y),
      width,
      height: round2(rect.height),
    },
    text: {
      characters,
      i18n: markerEntry
        ? { namespace: markerEntry.namespace, key: markerEntry.resolvedKey }
        : undefined,
      font: {
        family: firstFontFamily(parentStyle.fontFamily),
        weight: Number.parseFloat(parentStyle.fontWeight) || 400,
        italic: parentStyle.fontStyle.includes("italic"),
        size: fontSize,
        lineHeightPx: Number.isFinite(lineHeight) ? round2(lineHeight) : undefined,
        letterSpacing: Number.isFinite(letterSpacing)
          ? round2(letterSpacing)
          : undefined,
      },
      color,
      align: mapTextAlign(parentStyle.textAlign),
      autoWidth: sizing.autoWidth || undefined,
      fillWidth: sizing.fillWidth || undefined,
    },
  };
  attachTokens(node, ctx.tokens);
  return node;
}

async function serializeElement(
  el: Element,
  dbId: string,
  parentRect: Rect,
  ctx: WalkContext,
): Promise<RenderNode | null> {
  if (SKIPPED_TAGS.has(el.tagName)) return null;

  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;

  const rect = scaleRect(el.getBoundingClientRect(), ctx.scaleInv);
  if (rect.width === 0 && rect.height === 0) return null;

  // Nested registered component. Slot components (parent-authored children)
  // fall through and serialize INLINE as a plain frame stamped further down;
  // everything else becomes a childComponent placeholder whose tree is
  // serialized separately (see serializeComponent).
  const occurrence = ctx.boundary.get(el);
  if (occurrence && !occurrence.slot) {
    if (occurrence.hostRoots[0] !== el) return null; // sibling root, covered
    const union = unionRects(
      occurrence.hostRoots.map((root) =>
        scaleRect(root.getBoundingClientRect(), ctx.scaleInv),
      ),
    );
    const layout: RenderLayout = {
      mode: "none",
      x: round2(union.x - parentRect.x),
      y: round2(union.y - parentRect.y),
      width: round2(union.width),
      height: round2(union.height),
    };
    if (style.position === "absolute" || style.position === "fixed") {
      layout.absolute = true;
    }
    ctx.onOccurrence?.(occurrence, dbId, layout);
    return {
      dbId,
      type: "childComponent",
      name: occurrence.entryName,
      componentId: occurrence.entryId,
      layout,
    };
  }

  if (el instanceof SVGSVGElement) {
    const svgLayout: RenderLayout = {
      mode: "none",
      x: round2(rect.x - parentRect.x),
      y: round2(rect.y - parentRect.y),
      width: round2(rect.width),
      height: round2(rect.height),
    };
    if (style.position === "absolute" || style.position === "fixed") {
      svgLayout.absolute = true;
    }
    return {
      dbId,
      type: "svg",
      name: frameName(el),
      layout: svgLayout,
      svg: serializeSvg(el, rect),
    };
  }

  const record = styleRecord(style);
  const layout = flexToLayout(record, rect, parentRect);
  const visuals = styleToVisuals(record);

  // Non-flex block container → vertical autolayout when it is a clean stack
  // (enables HUG + native ABSOLUTE children; see upgradeBlockStack).
  if (layout.mode === "none" && el instanceof HTMLElement) {
    upgradeBlockStack(el, layout, rect, ctx.scaleInv);
  }
  // Content-determined height pushes as HUG so the pull emits no fixed
  // height (Bug B). Skipped for grow children (their size is flow-owned) and
  // for mode:"none" frames (Figma NONE layout has no hug — documented
  // residual: those keep FIXED sizes).
  if (
    layout.mode !== "none" &&
    !layout.grow &&
    el instanceof HTMLElement &&
    isContentHeight(el)
  ) {
    layout.hugHeight = true;
  }

  if (el instanceof HTMLImageElement) {
    const imageId = el.currentSrc || el.src
      ? await encodeImage(el.currentSrc || el.src, ctx)
      : undefined;
    const node: RenderNode = {
      dbId,
      type: "image",
      name: el.alt ? truncate(el.alt, 40) : "image",
      layout: { ...layout, mode: "none" },
      fills: imageId
        ? [{ kind: "image", imageId }]
        : [{ kind: "solid", color: PLACEHOLDER_GRAY }],
      cornerRadius: visuals.cornerRadius,
      opacity: visuals.opacity,
    };
    attachTokens(node, ctx.tokens);
    return node;
  }

  const fills = visuals.fills ? [...visuals.fills] : [];
  const backgroundUrl = extractBackgroundImageUrl(record["background-image"]);
  if (backgroundUrl) {
    const imageId = await encodeImage(backgroundUrl, ctx);
    fills.push(
      imageId
        ? { kind: "image", imageId }
        : { kind: "solid", color: PLACEHOLDER_GRAY },
    );
  }

  const node: RenderNode = {
    dbId,
    type: "frame",
    name: occurrence?.slot ? occurrence.entryName : frameName(el),
    layout,
    slotComponentId: occurrence?.slot ? occurrence.entryId : undefined,
    fills: fills.length > 0 ? fills : undefined,
    stroke: visuals.stroke,
    cornerRadius: visuals.cornerRadius,
    effects: visuals.effects,
    opacity: visuals.opacity,
    clipsContent: visuals.clipsContent,
  };
  attachTokens(node, ctx.tokens);

  const children: RenderNode[] = [];
  for (const childNode of Array.from(el.childNodes)) {
    const childId = `${dbId}.${children.length}`;
    if (childNode instanceof Element) {
      const child = await serializeElement(childNode, childId, rect, ctx);
      if (child) children.push(child);
    } else if (childNode.nodeType === Node.TEXT_NODE) {
      const child = serializeTextNode(
        childNode as Text,
        style,
        childId,
        rect,
        layout.mode,
        ctx,
      );
      if (child) children.push(child);
    }
  }
  if (layout.reverse) {
    children.reverse();
    delete layout.reverse;
  }
  if (children.length > 0) node.children = children;

  // Content-sized flex frame whose children are all auto-width texts (badge,
  // button label): hug in Figma so wider font metrics can't overflow it.
  if (
    layout.mode !== "none" &&
    !layout.grow &&
    children.length > 0 &&
    children.every((child) => child.type === "text" && child.text?.autoWidth)
  ) {
    layout.hug = true;
  }

  return node;
}

/** Serializes one occurrence (1..n host roots) as a standalone tree root. */
async function serializeRoots(
  roots: Element[],
  name: string,
  ctx: WalkContext,
): Promise<RenderNode | null> {
  if (roots.length === 1) {
    const rect = scaleRect(roots[0].getBoundingClientRect(), ctx.scaleInv);
    const node = await serializeElement(roots[0], "r", rect, ctx);
    if (node) {
      node.name = name;
      node.layout.x = 0;
      node.layout.y = 0;
      // The tree root is never absolute, whatever its CSS position was.
      delete node.layout.absolute;
    }
    return node;
  }

  const union = unionRects(
    roots.map((root) => scaleRect(root.getBoundingClientRect(), ctx.scaleInv)),
  );
  const children: RenderNode[] = [];
  for (const root of roots) {
    const child = await serializeElement(
      root,
      `r.${children.length}`,
      union,
      ctx,
    );
    if (child) children.push(child);
  }
  if (children.length === 0) return null;
  return {
    dbId: "r",
    type: "frame",
    name,
    layout: {
      mode: "none",
      x: 0,
      y: 0,
      width: round2(union.width),
      height: round2(union.height),
    },
    children,
  };
}

/** Collects `dbId → characters` for every text node in a serialized tree. */
function collectTextByPath(node: RenderNode, out: Map<string, string>): void {
  if (node.type === "text" && node.text) {
    out.set(node.dbId, node.text.characters);
  }
  for (const child of node.children ?? []) collectTextByPath(child, out);
}

/**
 * Serializes the component rendered under `rootEl` (the `[data-db-entry]`
 * wrapper around the canvas preview) into a `RenderTree`. Nested registered
 * components become `childComponent` nodes + `childComponents` entries; the
 * first occurrence's DOM provides each child's tree, later occurrences record
 * text overrides against it.
 */
async function serializeComponent(
  rootEl: Element,
  opts: SerializeOptions,
): Promise<SerializeResult> {
  const warnings: string[] = [];

  const rootDomRect = rootEl.getBoundingClientRect();
  const offsetWidth = (rootEl as HTMLElement).offsetWidth || rootDomRect.width;
  const scale = offsetWidth > 0 ? rootDomRect.width / offsetWidth : 1;
  const scaleInv = scale > 0 ? 1 / scale : 1;

  // Locate the entry component's fiber under the wrapper, then its shallowest
  // registered descendants (nested-component boundaries).
  const wrapperFiber = getFiberFromDom(rootEl);
  let entryHostRoots: Element[] = [rootEl];
  const boundary = new Map<Element, BoundaryOccurrence>();
  const occurrenceOrder = new Map<string, BoundaryOccurrence[]>();

  if (wrapperFiber) {
    const topLevel = collectSubtree(wrapperFiber, registryByRef, registryByName);
    const entryNode =
      topLevel.find((node) => node.entry.id === opts.componentId) ?? topLevel[0];
    if (entryNode) {
      const roots = collectHostRoots(entryNode.fiber);
      if (roots.length > 0) entryHostRoots = roots;

      // Slot-aware boundary walk: slot components (parent-authored children)
      // serialize inline and the walk continues into them; other registered
      // descendants become COMPONENT mains + instances.
      for (const descendant of collectSlotAwareSubtree(
        entryNode.fiber,
        registryByRef,
        registryByName,
        isSlotFiber,
      )) {
        const hostRoots = collectHostRoots(descendant.fiber);
        if (hostRoots.length === 0) continue;
        const occurrence: BoundaryOccurrence = {
          entryId: descendant.entry.id,
          entryName: descendant.entry.name,
          occurrenceIndex: descendant.occurrenceIndex,
          hostRoots,
          slot: descendant.slot,
        };
        for (const root of hostRoots) boundary.set(root, occurrence);
        if (descendant.slot) continue; // no main/instance for slots
        const list = occurrenceOrder.get(occurrence.entryId) ?? [];
        list.push(occurrence);
        occurrenceOrder.set(occurrence.entryId, list);
      }
    } else {
      warnings.push(
        "No registered component fiber found under the preview root; serializing the raw DOM.",
      );
    }
  } else {
    warnings.push(
      "No React fiber on the preview root; nested components will be flattened.",
    );
  }

  const ctx: WalkContext = {
    scaleInv,
    tokens: buildTokenMaps(rootEl),
    warnings,
    images: {},
    imageIdByUrl: new Map(),
    boundary,
  };

  // Occurrence placeholders found during the main walk, in walk order.
  const seen: Array<{
    occurrence: BoundaryOccurrence;
    dbId: string;
    layout: RenderLayout;
  }> = [];
  ctx.onOccurrence = (occurrence, dbId, layout) => {
    seen.push({ occurrence, dbId, layout });
  };

  const root = await serializeRoots(entryHostRoots, opts.componentName, ctx);
  if (!root) {
    throw new Error("Nothing to serialize: the preview rendered no visible DOM.");
  }

  // Serialize each child component: the first occurrence provides the tree,
  // every occurrence records its text overrides relative to that tree.
  const childCtx: WalkContext = { ...ctx, boundary: new Map(), onOccurrence: undefined };
  const childComponents: RenderTree["childComponents"] = {};
  for (const [entryId, occurrences] of occurrenceOrder) {
    const first = occurrences[0];
    const tree = await serializeRoots(first.hostRoots, first.entryName, childCtx);
    if (!tree) {
      warnings.push(`Nested component ${entryId} rendered no visible DOM; skipped.`);
      continue;
    }
    const baseText = new Map<string, string>();
    collectTextByPath(tree, baseText);

    const renderOccurrences: RenderOccurrence[] = [];
    for (const item of seen) {
      if (item.occurrence.entryId !== entryId) continue;
      const textOverrides: Array<{ path: string; characters: string }> = [];
      if (item.occurrence !== first) {
        const occTree = await serializeRoots(
          item.occurrence.hostRoots,
          first.entryName,
          { ...childCtx, skipImages: true, warnings: [] },
        );
        if (occTree) {
          const occText = new Map<string, string>();
          collectTextByPath(occTree, occText);
          for (const [path, characters] of occText) {
            const base = baseText.get(path);
            if (base !== undefined && base !== characters) {
              textOverrides.push({ path, characters });
            }
          }
        }
      }
      renderOccurrences.push({
        dbId: item.dbId,
        layout: item.layout,
        textOverrides,
      });
    }

    childComponents[entryId] = { tree, occurrences: renderOccurrences };
  }

  const tree: RenderTree = {
    componentId: opts.componentId,
    componentName: opts.componentName,
    images: ctx.images,
    root,
    childComponents,
    meta: {
      locale: opts.meta.locale,
      variant: opts.meta.variant,
      mode: opts.meta.mode,
      collection: opts.meta.collection,
      dimensions: opts.meta.dimensions,
      pushedAt: new Date().toISOString(),
      hash: "",
    },
  };
  tree.meta.hash = hashRenderTree(tree);

  const size = JSON.stringify(tree).length;
  if (size > MAX_TREE_BYTES) {
    throw new Error(
      `Serialized component is too large to push (${(size / 1024 / 1024).toFixed(1)}MB > ${MAX_TREE_BYTES / 1024 / 1024}MB). Try a smaller dataset or fewer images.`,
    );
  }

  return { tree, warnings };
}

declare global {
  interface Window {
    /** Debug/e2e hook: serialize a preview root without clicking the button. */
    __designbookFigmaSerialize?: typeof serializeComponent;
  }
}
if (typeof window !== "undefined") {
  window.__designbookFigmaSerialize = serializeComponent;
}

export { serializeComponent };
export type { SerializeOptions, SerializeResult };
