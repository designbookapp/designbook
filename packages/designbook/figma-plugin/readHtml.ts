/**
 * `figma_read_html` — reads a designbook component out of Figma as the
 * annotated HTML target for the declarative "pull from Figma" flow. The
 * root frame is located by its
 * sharedPluginData stamp (componentId + kind:"root", written by render.ts).
 *
 * The walk maps each native node to the shared, pure `HtmlNode` shape
 * (../src/config/figmaHtml.ts) and then renders it with `htmlNodeToString`:
 *  - Component Properties (text / boolean / instance-swap) and `#`-prefixed
 *    layer names → content/prop slots (`data-slot` / `data-i18n`).
 *  - `boundVariables` → token bindings (`data-token-<cssProp>`).
 *  - INSTANCE `mainComponent` (name = registry id) → a nested component
 *    reference (`data-component`); recursion stops there.
 *  - A frame named `items[]` → a list container (`data-list`); only its first
 *    child is kept as the item template.
 *  - Everything else → static HTML with a minimal inline style.
 *
 * Framework-free beyond the Figma plugin API; ES2017-safe.
 */

import { htmlNodeToString, type HtmlNode } from "../src/config/figmaHtml.ts";
import {
  i18nValueFromSlotName,
  isI18nSlotName,
} from "../src/config/figmaSlots.ts";
import {
  figmaNodeToCss,
  isStretchDefault,
  type FigmaNodeSnapshot,
  type ParentLayoutContext,
  type SnapshotBoundTokens,
  type SnapshotEffect,
  type SnapshotPaint,
} from "../src/config/figmaReadCss.ts";
import { parseRootMarker } from "../src/config/figmaRender.ts";
import type { PullRenderContext } from "../src/config/figmaRender.ts";
import type { Rgba } from "../src/config/color.ts";

const NS = "designbook";
const MAX_DEPTH = 50;

type VariableNameCache = Map<string, string | undefined>;

async function variableName(
  id: string,
  cache: VariableNameCache,
): Promise<string | undefined> {
  if (cache.has(id)) return cache.get(id);
  let name: string | undefined;
  try {
    const variable = await figma.variables.getVariableByIdAsync(id);
    name = variable ? variable.name : undefined;
  } catch {
    name = undefined;
  }
  cache.set(id, name);
  return name;
}

function rgba(color: RGBA): Rgba {
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

/**
 * Strips Figma's internal `#<id>` suffix off a component-property reference key
 * ("Show Badge#12:0" → "Show Badge").
 */
function propName(reference: string): string {
  const hash = reference.lastIndexOf("#");
  return hash === -1 ? reference : reference.slice(0, hash);
}

/** The property key a given node aspect ("characters" | "visible" | …) binds. */
function propRef(node: SceneNode, aspect: string): string | undefined {
  const refs = (node as SceneNode & {
    componentPropertyReferences?: Record<string, string> | null;
  }).componentPropertyReferences;
  const value = refs ? refs[aspect] : undefined;
  return value ? propName(value) : undefined;
}

/**
 * Slot name for a text/content node: a bound Component Property (via
 * `characters`), else a `#`-prefixed layer name, else undefined (static).
 */
function slotNameOf(node: SceneNode, aspect: string): string | undefined {
  const fromProp = propRef(node, aspect);
  if (fromProp) return fromProp;
  if (node.name.charAt(0) === "#") return node.name.slice(1);
  return undefined;
}

/** Routes a slot name to `{ i18n }` or `{ slot }` (the `i18n.` prefix wins). */
function applySlotName(target: HtmlNode, name: string): void {
  if (isI18nSlotName(name)) target.i18n = i18nValueFromSlotName(name);
  else target.slot = name;
}

type BoundVariablesRecord = Record<
  string,
  VariableAlias | VariableAlias[] | undefined
>;

/** Resolved name of a number-field variable alias (undefined when unbound). */
async function aliasName(
  bound: BoundVariablesRecord | undefined,
  field: string,
  cache: VariableNameCache,
): Promise<string | undefined> {
  const alias = bound ? bound[field] : undefined;
  if (!alias || Array.isArray(alias)) return undefined;
  return variableName(alias.id, cache);
}

/** Visible paints → plain snapshot paints, color-variable ids → names. */
async function paintsSnapshot(
  paints: readonly Paint[] | typeof figma.mixed,
  cache: VariableNameCache,
): Promise<SnapshotPaint[] | undefined> {
  if (!Array.isArray(paints)) return undefined;
  const out: SnapshotPaint[] = [];
  for (const paint of paints as Paint[]) {
    if (paint.visible === false) continue;
    if (paint.type === "SOLID") {
      const bound = paint.boundVariables ? paint.boundVariables.color : undefined;
      const name = bound ? await variableName(bound.id, cache) : undefined;
      out.push({
        type: "SOLID",
        color: { r: paint.color.r, g: paint.color.g, b: paint.color.b },
        opacity: paint.opacity,
        colorToken: name,
      });
    } else if (paint.type === "GRADIENT_LINEAR") {
      out.push({
        type: "GRADIENT_LINEAR",
        gradientTransform: paint.gradientTransform,
        stops: paint.gradientStops.map((stop) => ({
          position: stop.position,
          color: rgba(stop.color),
        })),
      });
    } else {
      // IMAGE and radial/angular/diamond gradients have no CSS readback yet.
      out.push({ type: "OTHER" });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Visible shadow effects → plain snapshot effects. */
function effectsSnapshot(effects: readonly Effect[]): SnapshotEffect[] | undefined {
  const out: SnapshotEffect[] = [];
  for (const effect of effects) {
    if (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW") continue;
    if (effect.visible === false) continue;
    out.push({
      type: effect.type,
      color: rgba(effect.color),
      offset: { x: effect.offset.x, y: effect.offset.y },
      radius: effect.radius,
      spread: effect.spread,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Builds the plain, serializable snapshot of a node that the pure mapper
 * (src/config/figmaReadCss.ts) consumes: raw layout/visual/text fields plus
 * every variable binding resolved to its NAME.
 */
async function snapshotOf(
  node: SceneNode,
  cache: VariableNameCache,
): Promise<FigmaNodeSnapshot> {
  const snap: FigmaNodeSnapshot = {};
  if (node.type === "TEXT") snap.isText = true;
  snap.width = node.width;
  snap.height = node.height;
  // Parent-relative position + the autolayout opt-out flag: the mapper only
  // uses them for absolutely positioned children (NONE-layout parent or
  // layoutPositioning ABSOLUTE) — see figmaReadCss.ts.
  snap.x = node.x;
  snap.y = node.y;
  if ("layoutPositioning" in node) snap.layoutPositioning = node.layoutPositioning;

  const bound = (node as SceneNode & { boundVariables?: BoundVariablesRecord })
    .boundVariables;

  if ("fills" in node) snap.fills = await paintsSnapshot(node.fills, cache);
  if ("strokes" in node) {
    snap.strokes = await paintsSnapshot(node.strokes, cache);
    if ("strokeWeight" in node && typeof node.strokeWeight === "number") {
      snap.strokeWeight = node.strokeWeight;
    }
  }

  // Corner radii: individual corners cover the mixed case; the uniform token
  // binding rides the topLeftRadius alias (push binds all four to one var).
  if ("topLeftRadius" in node) {
    snap.radii = [
      node.topLeftRadius,
      node.topRightRadius,
      node.bottomRightRadius,
      node.bottomLeftRadius,
    ];
  } else if ("cornerRadius" in node) {
    const radius = (node as SceneNode & { cornerRadius: number | typeof figma.mixed })
      .cornerRadius;
    if (typeof radius === "number") snap.radii = [radius, radius, radius, radius];
  }

  const tokens: SnapshotBoundTokens = {};
  tokens.topLeftRadius = await aliasName(bound, "topLeftRadius", cache);

  if ("layoutMode" in node) {
    const mode = node.layoutMode;
    // GRID (Figma's newer grid autolayout) has no CSS readback yet — push
    // never writes it; treat it as a plain frame.
    snap.layoutMode =
      mode === "HORIZONTAL" || mode === "VERTICAL" ? mode : "NONE";
    if (snap.layoutMode !== "NONE") {
      const frame = node as FrameNode;
      snap.primaryAxisSizingMode = frame.primaryAxisSizingMode;
      snap.counterAxisSizingMode = frame.counterAxisSizingMode;
      snap.primaryAxisAlignItems = frame.primaryAxisAlignItems;
      snap.counterAxisAlignItems = frame.counterAxisAlignItems;
      snap.itemSpacing = frame.itemSpacing;
      snap.counterAxisSpacing = frame.counterAxisSpacing;
      snap.layoutWrap = frame.layoutWrap;
      snap.paddingTop = frame.paddingTop;
      snap.paddingRight = frame.paddingRight;
      snap.paddingBottom = frame.paddingBottom;
      snap.paddingLeft = frame.paddingLeft;
      tokens.itemSpacing = await aliasName(bound, "itemSpacing", cache);
      tokens.paddingTop = await aliasName(bound, "paddingTop", cache);
      tokens.paddingRight = await aliasName(bound, "paddingRight", cache);
      tokens.paddingBottom = await aliasName(bound, "paddingBottom", cache);
      tokens.paddingLeft = await aliasName(bound, "paddingLeft", cache);
    }
  }

  if ("layoutGrow" in node && typeof node.layoutGrow === "number") {
    snap.layoutGrow = node.layoutGrow;
  }
  if ("layoutAlign" in node) snap.layoutAlign = node.layoutAlign;
  if ("children" in node) {
    const visibleChildren = (node as ChildrenMixin & SceneNode).children.filter(
      (child) => child.visible !== false,
    );
    // Absolute-positioned children opt out of the autolayout flow: excluded
    // from the stretch-default probe, but flagged so the parent can emit
    // `position: relative`. Under a non-autolayout container EVERY child is
    // freely positioned (push writes CSS-absolute subtrees as layoutMode NONE
    // + child x/y — render.ts appendChildren).
    const inFlow = visibleChildren.filter(
      (child) =>
        !("layoutPositioning" in child) ||
        child.layoutPositioning !== "ABSOLUTE",
    );
    snap.childLayoutAligns = inFlow.map((child) =>
      "layoutAlign" in child ? child.layoutAlign : "INHERIT",
    );
    const autolayout =
      snap.layoutMode === "HORIZONTAL" || snap.layoutMode === "VERTICAL";
    if (
      (autolayout && inFlow.length !== visibleChildren.length) ||
      (!autolayout && visibleChildren.length > 0)
    ) {
      snap.hasAbsoluteChildren = true;
    }
  }
  if ("minWidth" in node) {
    snap.minWidth = node.minWidth;
    snap.maxWidth = node.maxWidth;
    snap.minHeight = node.minHeight;
    snap.maxHeight = node.maxHeight;
  }

  if ("effects" in node) snap.effects = effectsSnapshot(node.effects);
  if ("opacity" in node) snap.opacity = node.opacity;
  if ("clipsContent" in node) snap.clipsContent = node.clipsContent;

  if (node.type === "TEXT") {
    if (typeof node.fontSize === "number") snap.fontSize = node.fontSize;
    const fontName = node.fontName;
    if (typeof fontName === "object") {
      snap.fontName = { family: fontName.family, style: fontName.style };
    }
    const lineHeight = node.lineHeight;
    if (typeof lineHeight === "object" && lineHeight.unit !== "AUTO") {
      if (lineHeight.unit === "PIXELS") snap.lineHeightPx = lineHeight.value;
      else snap.lineHeightPercent = lineHeight.value;
    }
    const letterSpacing = node.letterSpacing;
    if (typeof letterSpacing === "object") {
      if (letterSpacing.unit === "PIXELS") snap.letterSpacingPx = letterSpacing.value;
      else snap.letterSpacingPercent = letterSpacing.value;
    }
    snap.textAlignHorizontal = node.textAlignHorizontal;
    snap.textAutoResize = node.textAutoResize;
    if (typeof node.textDecoration === "string") {
      snap.textDecoration = node.textDecoration;
    }
    if (typeof node.textCase === "string") snap.textCase = node.textCase;
  }

  if (
    tokens.itemSpacing ||
    tokens.topLeftRadius ||
    tokens.paddingTop ||
    tokens.paddingRight ||
    tokens.paddingBottom ||
    tokens.paddingLeft
  ) {
    snap.boundTokens = tokens;
  }
  return snap;
}

/**
 * Reads token bindings + static style for a frame/text node via the pure
 * mapper; returns the snapshot so the caller can derive the children's
 * parent-layout context.
 */
async function readVisual(
  node: SceneNode,
  cache: VariableNameCache,
  target: HtmlNode,
  parent: ParentLayoutContext | undefined,
): Promise<FigmaNodeSnapshot> {
  const snap = await snapshotOf(node, cache);
  const mapped = figmaNodeToCss(snap, parent);
  if (Object.keys(mapped.tokens).length > 0) target.tokens = mapped.tokens;
  if (Object.keys(mapped.style).length > 0) target.style = mapped.style;
  return snap;
}

async function readNode(
  node: SceneNode,
  cache: VariableNameCache,
  depth: number,
  parent: ParentLayoutContext | undefined,
): Promise<HtmlNode | undefined> {
  // Skip invisible nodes UNLESS they are a boolean show/hide slot (Pi still
  // needs to know the slot exists).
  const visibleSlot = propRef(node, "visible");
  if (node.visible === false && !visibleSlot) return undefined;

  // Nested registered component (or instance-swap slot).
  if (node.type === "INSTANCE") {
    const out: HtmlNode = {};
    const swap = propRef(node, "mainComponent");
    if (swap) out.slotSwap = swap;
    let componentId = node.getSharedPluginData(NS, "componentId");
    if (!componentId) {
      try {
        const main = await node.getMainComponentAsync();
        componentId = main ? main.name : "";
      } catch {
        componentId = "";
      }
    }
    if (componentId) out.component = componentId;
    // Positioning readback: an absolutely-positioned instance (e.g. the
    // ProductBadges overlay — NONE-layout parent, or layoutPositioning
    // ABSOLUTE inside autolayout) must keep position/left/top + its size on
    // the `data-component` node. The snapshot is deliberately MINIMAL:
    // fills, text and internal layout belong to the component's own
    // definition, so they are neither read nor recursed into, and in-flow
    // instances keep emitting no style at all.
    const snap: FigmaNodeSnapshot = {
      width: node.width,
      height: node.height,
      x: node.x,
      y: node.y,
    };
    if ("layoutPositioning" in node) {
      snap.layoutPositioning = node.layoutPositioning;
    }
    if (
      parent &&
      (parent.layoutMode === "NONE" || snap.layoutPositioning === "ABSOLUTE")
    ) {
      const mapped = figmaNodeToCss(snap, parent);
      if (Object.keys(mapped.style).length > 0) out.style = mapped.style;
    }
    return out;
  }

  if (node.type === "TEXT") {
    const out: HtmlNode = { tag: "span", text: node.characters };
    const name = slotNameOf(node, "characters");
    if (name) applySlotName(out, name);
    if (visibleSlot) {
      out.slotIf = visibleSlot;
      if (node.visible === false) out.hidden = true;
    }
    await readVisual(node, cache, out, parent);
    return out;
  }

  // Frame / component / group-ish container.
  const out: HtmlNode = {};
  if (visibleSlot) {
    out.slotIf = visibleSlot;
    if (node.visible === false) out.hidden = true;
  }
  const contentSlot = slotNameOf(node, "characters");
  if (contentSlot) applySlotName(out, contentSlot);
  const snap = await readVisual(node, cache, out, parent);

  const isList = node.name === "items[]";
  if (isList) out.list = true;

  if ("children" in node && depth < MAX_DEPTH) {
    // The children's parent-layout context: autolayout mode plus whether the
    // counter axis resolved to CSS-default stretch (children then omit the
    // redundant `align-self: stretch`).
    const childContext: ParentLayoutContext =
      snap.layoutMode === "HORIZONTAL" || snap.layoutMode === "VERTICAL"
        ? { layoutMode: snap.layoutMode, stretchChildren: isStretchDefault(snap) }
        : { layoutMode: "NONE" };
    const source = (node as ChildrenMixin & SceneNode).children;
    const children: HtmlNode[] = [];
    for (const child of source) {
      const built = await readNode(child, cache, depth + 1, childContext);
      if (built) children.push(built);
      // A list container keeps only the first item as the template.
      if (isList && children.length === 1) break;
    }
    if (children.length > 0) out.children = children;
  }

  return out;
}

type ReadHtmlParams = {
  componentId: string;
};

type ReadHtmlResult = {
  componentId: string;
  rootNodeId: string;
  html: string;
  /**
   * Render context the push stamped into the root marker (which single
   * rendering the target reflects). Absent for pre-context pushes or a
   * malformed marker — the pull prompt then omits its context line.
   */
  render?: PullRenderContext;
};

async function readHtml(params: ReadHtmlParams): Promise<ReadHtmlResult> {
  const componentId = params ? params.componentId : undefined;
  if (typeof componentId !== "string" || componentId === "") {
    throw new Error("figma_read_html: params.componentId is required.");
  }

  const stamped = figma.currentPage.findAllWithCriteria({
    sharedPluginData: { namespace: NS, keys: ["componentId"] },
  });
  const root = stamped.find(
    (node) =>
      node.getSharedPluginData(NS, "componentId") === componentId &&
      node.getSharedPluginData(NS, "kind") === "root",
  );
  if (!root) {
    // "[not-found]" is the machine-readable code the bridge/server sniff for 404.
    throw new Error(
      `[not-found] No pushed designbook root for "${componentId}" on the current page. Push the component to Figma first (or re-push if the frame was deleted).`,
    );
  }

  const cache: VariableNameCache = new Map();
  const tree = (await readNode(root, cache, 0, undefined)) ?? { children: [] };
  const marker = parseRootMarker(root.getSharedPluginData(NS, "root"));
  const result: ReadHtmlResult = {
    componentId,
    rootNodeId: root.id,
    html: htmlNodeToString(tree),
  };
  if (marker && marker.render) result.render = marker.render;
  return result;
}

export { readHtml };
export type { ReadHtmlParams, ReadHtmlResult };
