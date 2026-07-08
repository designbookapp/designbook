/**
 * `figma_render_nodes` — builds native Figma nodes from a designbook
 * `RenderTree` (see ../src/config/figmaRender.ts, shared with the browser
 * serializer). Frames become autolayout frames, text becomes TEXT nodes,
 * inline SVGs go through `createNodeFromSvg`, images become image fills, and
 * nested registered components become COMPONENT mains (parked in a
 * "designbook / components" section) plus INSTANCE nodes — except slot
 * components (`slotComponentId`), which arrive pre-inlined as plain frames
 * and are stamped kind:"slot".
 *
 * Every node is stamped with sharedPluginData (namespace "designbook") so a
 * re-push can find the previous root/mains and rebuild them in place — node
 * ids stay stable, so links and instances elsewhere keep working.
 */

import {
  cssWeightToFigmaStyle,
  formatRootMarker,
  ROOT_MARKER_VERSION,
} from "../src/config/figmaRender.ts";
import type {
  PullRenderContext,
  RenderLayout,
  RenderNode,
  RenderPaint,
  RenderTree,
} from "../src/config/figmaRender.ts";
import { i18nBinding, isI18nSlotName } from "../src/config/figmaSlots.ts";
import {
  collectMainSlots,
  slotDescriptorToPropertyDef,
  slotReferenceAspect,
} from "../src/config/figmaComponentProps.ts";
import type { Rgba } from "../src/config/color.ts";

const NS = "designbook";
const DEFAULT_COLLECTION = "designbook/theme";
const COMPONENTS_SECTION_NAME = "designbook / components";
const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };

type RenderCounts = {
  frames: number;
  texts: number;
  svgs: number;
  images: number;
  instances: number;
};

type RenderNodesResult = {
  nodeId: string;
  url: string;
  created: boolean;
  counts: RenderCounts;
  warnings: string[];
};

type BuildContext = {
  fonts: Map<string, FontName>;
  variables: Map<string, Variable>;
  /**
   * The collection modeId matching the pushed mode (`tree.meta.mode`), or
   * undefined when the collection/mode is missing. Bound variables whose
   * value in THIS mode differs from the pushed resolved value get refreshed
   * (the push is the source of truth for the tokens it touches).
   */
  modeId?: string;
  /** Names of variables whose stale values were refreshed during this push. */
  refreshedVariables: Set<string>;
  imageHashes: Map<string, string>;
  mains: Map<string, ComponentNode>;
  counts: RenderCounts;
  warnings: string[];
};

function fontKey(family: string, weight: number, italic: boolean): string {
  return `${family}|${weight}|${italic}`;
}

/** Collects every text node in a tree (root + children, recursively). */
function walkNodes(node: RenderNode, visit: (node: RenderNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkNodes(child, visit);
}

/**
 * Resolves + loads every font the tree needs, up front. Family matches are
 * exact first, then case-insensitive; style candidates come from
 * `cssWeightToFigmaStyle`, falling back to Regular, then to the family's
 * first style, then to Inter Regular (with a warning).
 */
async function resolveFonts(
  tree: RenderTree,
  warnings: string[],
): Promise<Map<string, FontName>> {
  const needed = new Map<
    string,
    { family: string; weight: number; italic: boolean }
  >();
  const collect = (node: RenderNode) => {
    if (node.text) {
      const font = node.text.font;
      needed.set(fontKey(font.family, font.weight, font.italic), {
        family: font.family,
        weight: font.weight,
        italic: font.italic,
      });
    }
  };
  walkNodes(tree.root, collect);
  for (const key of Object.keys(tree.childComponents)) {
    walkNodes(tree.childComponents[key].tree, collect);
  }

  const resolved = new Map<string, FontName>();
  if (needed.size === 0) return resolved;

  const available = await figma.listAvailableFontsAsync();
  // family (exact) -> lowercased style -> FontName; plus lowercase family index.
  const familiesExact = new Map<string, Map<string, FontName>>();
  const familyByLower = new Map<string, string>();
  for (const font of available) {
    const { family, style } = font.fontName;
    let styles = familiesExact.get(family);
    if (!styles) {
      styles = new Map();
      familiesExact.set(family, styles);
      const lower = family.toLowerCase();
      if (!familyByLower.has(lower)) familyByLower.set(lower, family);
    }
    styles.set(style.toLowerCase(), font.fontName);
  }

  const toLoad = new Map<string, FontName>();
  for (const [key, spec] of needed) {
    const exactFamily = familiesExact.has(spec.family)
      ? spec.family
      : familyByLower.get(spec.family.toLowerCase());
    let fontName: FontName | undefined;

    if (exactFamily) {
      const styles = familiesExact.get(exactFamily)!;
      const candidates = cssWeightToFigmaStyle(spec.weight, spec.italic);
      for (const candidate of candidates) {
        const match = styles.get(candidate.toLowerCase());
        if (match) {
          fontName = match;
          break;
        }
      }
      if (!fontName) fontName = styles.get("regular");
      if (!fontName) {
        const first = styles.values().next();
        fontName = first.done ? undefined : first.value;
      }
      if (
        fontName &&
        fontName.style.toLowerCase() !==
          cssWeightToFigmaStyle(spec.weight, spec.italic)[0].toLowerCase()
      ) {
        warnings.push(
          `Font "${spec.family}" weight ${spec.weight}${spec.italic ? " italic" : ""} not available; used style "${fontName.style}".`,
        );
      }
    }

    if (!fontName) {
      warnings.push(
        `Font family "${spec.family}" not available in Figma; used Inter.`,
      );
      const interStyles = familiesExact.get("Inter");
      const candidates = cssWeightToFigmaStyle(spec.weight, spec.italic);
      for (const candidate of candidates) {
        const match = interStyles?.get(candidate.toLowerCase());
        if (match) {
          fontName = match;
          break;
        }
      }
      fontName = fontName ?? FALLBACK_FONT;
    }

    resolved.set(key, fontName);
    toLoad.set(`${fontName.family}|${fontName.style}`, fontName);
  }

  for (const font of toLoad.values()) {
    await figma.loadFontAsync(font);
  }
  return resolved;
}

/**
 * Name → Variable for the tree's variable collection (empty if missing), plus
 * the modeId matching `modeName` (same name→id mapping as the token sync's
 * `setVariables` in code.ts; undefined when the collection lacks that mode —
 * e.g. a single-mode Figma plan — in which case stale-value refresh is
 * skipped rather than touching the wrong mode).
 */
async function resolveVariables(
  collectionName: string,
  modeName: string | undefined,
): Promise<{ variables: Map<string, Variable>; modeId?: string }> {
  const map = new Map<string, Variable>();
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collection = collections.find(
    (candidate) => candidate.name === collectionName,
  );
  if (!collection) return { variables: map };
  for (const id of collection.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable) map.set(variable.name, variable);
  }
  const mode = modeName
    ? collection.modes.find((candidate) => candidate.name === modeName)
    : undefined;
  return { variables: map, modeId: mode ? mode.modeId : undefined };
}

/** Channel tolerance for treating a variable value as already current. */
const REFRESH_EPSILON = 0.002; // < half a 1/255 color step
const REFRESH_FLOAT_EPSILON = 0.01; // px values are round2'd on push

function isVariableAlias(value: VariableValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as VariableAlias).type === "VARIABLE_ALIAS"
  );
}

/**
 * Bug fix (stale bound-variable values): a push binds node properties to
 * existing variables, but the variable's VALUE may lag the theme (e.g. Figma
 * still has last month's `primary`) — the node then renders the stale color.
 * A component push makes the variables it touches current: when the pushed
 * resolved value differs from the variable's value in the push's target mode,
 * the variable is refreshed and counted (surfaced as a push warning, like the
 * font-fallback notices). Only variables actually bound during this push and
 * only the pushed mode are touched; alias values are left alone.
 */
function refreshVariableValue(
  variable: Variable,
  value: RGBA | number,
  ctx: BuildContext,
): void {
  const modeId = ctx.modeId;
  if (!modeId) return;
  const current = variable.valuesByMode[modeId];
  if (current !== undefined && isVariableAlias(current)) return;
  let stale = current === undefined;
  if (!stale) {
    if (typeof value === "number") {
      stale =
        typeof current !== "number" ||
        Math.abs(current - value) > REFRESH_FLOAT_EPSILON;
    } else {
      const rgba = current as RGBA;
      stale =
        typeof rgba !== "object" ||
        rgba === null ||
        Math.abs(rgba.r - value.r) > REFRESH_EPSILON ||
        Math.abs(rgba.g - value.g) > REFRESH_EPSILON ||
        Math.abs(rgba.b - value.b) > REFRESH_EPSILON ||
        Math.abs(rgba.a - value.a) > REFRESH_EPSILON;
    }
  }
  if (!stale) return;
  try {
    variable.setValueForMode(modeId, value);
    ctx.refreshedVariables.add(variable.name);
  } catch (error) {
    ctx.warnings.push(
      `Stale value of variable "${variable.name}" could not be refreshed (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

function rgb(color: Rgba): RGB {
  return { r: color.r, g: color.g, b: color.b };
}

function solidPaint(
  color: Rgba,
  tokenName: string | undefined,
  ctx: BuildContext,
): SolidPaint {
  let paint: SolidPaint = { type: "SOLID", color: rgb(color), opacity: color.a };
  if (tokenName) {
    const variable = ctx.variables.get(tokenName);
    if (variable) {
      refreshVariableValue(
        variable,
        { r: color.r, g: color.g, b: color.b, a: color.a },
        ctx,
      );
      paint = figma.variables.setBoundVariableForPaint(
        paint,
        "color",
        variable,
      ) as SolidPaint;
    }
  }
  return paint;
}

/** CSS gradient angle (0 = to top, clockwise) → Figma gradientTransform. */
function gradientTransformForAngle(angleDeg: number): Transform {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [cos, sin, 0.5 - cos / 2 - sin / 2],
    [-sin, cos, 0.5 + sin / 2 - cos / 2],
  ];
}

function buildPaint(paint: RenderPaint, ctx: BuildContext): Paint | undefined {
  if (paint.kind === "solid") {
    return solidPaint(paint.color, paint.tokenName, ctx);
  }
  if (paint.kind === "gradient") {
    return {
      type: "GRADIENT_LINEAR",
      gradientTransform: gradientTransformForAngle(paint.angle),
      gradientStops: paint.stops.map((stop) => ({
        position: stop.position,
        color: {
          r: stop.color.r,
          g: stop.color.g,
          b: stop.color.b,
          a: stop.color.a,
        },
      })),
    };
  }
  const hash = ctx.imageHashes.get(paint.imageId);
  if (!hash) {
    ctx.warnings.push(`Missing image payload "${paint.imageId}"; skipped fill.`);
    return undefined;
  }
  return { type: "IMAGE", scaleMode: "FILL", imageHash: hash };
}

/**
 * The visible layer name for a text node. i18n text is named with the
 * `#i18n.<ns>.<key>` slot convention (namespace always explicit) so the
 * declarative pull (readHtml.ts) can recover the translation key from a native
 * surface — no per-node pluginData. Everything else keeps its serialized name
 * (static design).
 */
function textLayerName(rn: RenderNode): string {
  const i18n = rn.text ? rn.text.i18n : undefined;
  if (i18n) return i18nBinding(i18n.namespace, i18n.key).layerName;
  return rn.name;
}

function applyLayout(
  node: FrameNode | ComponentNode,
  layout: RenderLayout,
): void {
  node.resizeWithoutConstraints(
    Math.max(0.01, layout.width),
    Math.max(0.01, layout.height),
  );
  if (layout.mode === "none") {
    node.layoutMode = "NONE";
    return;
  }

  node.layoutMode = layout.mode === "horizontal" ? "HORIZONTAL" : "VERTICAL";
  node.primaryAxisSizingMode = "FIXED";
  node.counterAxisSizingMode = "FIXED";
  node.itemSpacing = layout.gap ?? 0;
  if (layout.wrap && node.layoutMode === "HORIZONTAL") {
    node.layoutWrap = "WRAP";
    node.counterAxisSpacing = layout.counterGap ?? layout.gap ?? 0;
  }
  const padding = layout.padding ?? [0, 0, 0, 0];
  node.paddingTop = padding[0];
  node.paddingRight = padding[1];
  node.paddingBottom = padding[2];
  node.paddingLeft = padding[3];

  // Content-sized frames (all-auto-width-text children) hug their WIDTH so
  // Figma's font metrics can't overflow the browser-measured size. Height
  // stays FIXED — CSS often pins it (e.g. a 32px button) and text height
  // metrics are close enough.
  if (layout.hug) {
    if (node.layoutMode === "HORIZONTAL") node.primaryAxisSizingMode = "AUTO";
    else node.counterAxisSizingMode = "AUTO";
  }
  // Content-determined height (the serializer measured `height: auto` as a
  // no-op): hug vertically so the pull emits no fixed height to hardcode.
  if (layout.hugHeight) {
    if (node.layoutMode === "HORIZONTAL") node.counterAxisSizingMode = "AUTO";
    else node.primaryAxisSizingMode = "AUTO";
  }

  switch (layout.primaryAlign) {
    case "center":
      node.primaryAxisAlignItems = "CENTER";
      break;
    case "max":
      node.primaryAxisAlignItems = "MAX";
      break;
    case "space-between":
      node.primaryAxisAlignItems = "SPACE_BETWEEN";
      break;
    default:
      node.primaryAxisAlignItems = "MIN";
  }
  switch (layout.counterAlign) {
    case "center":
      node.counterAxisAlignItems = "CENTER";
      break;
    case "max":
      node.counterAxisAlignItems = "MAX";
      break;
    case "baseline":
      // BASELINE is only valid for horizontal autolayout.
      node.counterAxisAlignItems =
        node.layoutMode === "HORIZONTAL" ? "BASELINE" : "MIN";
      break;
    default:
      // min + stretch both anchor at MIN; stretch is applied per-child via
      // layoutAlign (see appendChildren).
      node.counterAxisAlignItems = "MIN";
  }
}

function bindNumberVariable(
  node: SceneNode,
  fields: VariableBindableNodeField[],
  tokenName: string | undefined,
  /** The pushed resolved px value (drives the stale-value refresh). */
  value: number | undefined,
  ctx: BuildContext,
): void {
  if (!tokenName) return;
  const variable = ctx.variables.get(tokenName);
  if (!variable) return;
  if (value !== undefined) refreshVariableValue(variable, value, ctx);
  for (const field of fields) {
    (node as SceneNode & {
      setBoundVariable(field: VariableBindableNodeField, variable: Variable): void;
    }).setBoundVariable(field, variable);
  }
}

function applyFrameVisuals(
  frame: FrameNode | ComponentNode,
  rn: RenderNode,
  ctx: BuildContext,
): void {
  const fills: Paint[] = [];
  for (const paint of rn.fills ?? []) {
    const built = buildPaint(paint, ctx);
    if (built) fills.push(built);
  }
  frame.fills = fills;

  if (rn.stroke) {
    frame.strokes = [solidPaint(rn.stroke.color, rn.stroke.tokenName, ctx)];
    frame.strokeWeight = rn.stroke.weight;
    frame.strokeAlign = "INSIDE";
  } else {
    frame.strokes = [];
  }

  if (typeof rn.cornerRadius === "number") {
    frame.cornerRadius = rn.cornerRadius;
    bindNumberVariable(
      frame,
      ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"],
      rn.radiusToken,
      rn.cornerRadius,
      ctx,
    );
  } else if (rn.cornerRadius) {
    frame.topLeftRadius = rn.cornerRadius[0];
    frame.topRightRadius = rn.cornerRadius[1];
    frame.bottomRightRadius = rn.cornerRadius[2];
    frame.bottomLeftRadius = rn.cornerRadius[3];
  }

  if (rn.effects && rn.effects.length > 0) {
    frame.effects = rn.effects.map((effect): Effect => ({
      type: effect.kind === "inner-shadow" ? "INNER_SHADOW" : "DROP_SHADOW",
      color: {
        r: effect.color.r,
        g: effect.color.g,
        b: effect.color.b,
        a: effect.color.a,
      },
      offset: { x: effect.x, y: effect.y },
      radius: Math.max(0, effect.blur),
      spread: effect.spread,
      visible: true,
      blendMode: "NORMAL",
    }));
  }

  if (rn.opacity !== undefined) frame.opacity = rn.opacity;
  frame.clipsContent = rn.clipsContent ?? false;

  if (rn.layout.mode !== "none") {
    bindNumberVariable(
      frame,
      ["itemSpacing"],
      rn.gapToken,
      rn.layout.gap ?? 0,
      ctx,
    );
  }
}

function buildText(rn: RenderNode, ctx: BuildContext): TextNode {
  const spec = rn.text!;
  const text = figma.createText();
  const font =
    ctx.fonts.get(fontKey(spec.font.family, spec.font.weight, spec.font.italic)) ??
    FALLBACK_FONT;
  text.fontName = font;
  text.characters = spec.characters;
  text.fontSize = spec.font.size;
  if (spec.font.lineHeightPx !== undefined) {
    text.lineHeight = { value: spec.font.lineHeightPx, unit: "PIXELS" };
  }
  if (spec.font.letterSpacing !== undefined) {
    text.letterSpacing = { value: spec.font.letterSpacing, unit: "PIXELS" };
  }
  text.fills = [solidPaint(spec.color, spec.colorToken, ctx)];
  text.textAlignHorizontal =
    spec.align === "center"
      ? "CENTER"
      : spec.align === "right"
        ? "RIGHT"
        : spec.align === "justified"
          ? "JUSTIFIED"
          : "LEFT";
  if (spec.autoWidth) {
    // Single-line in the browser: hug both axes — can never wrap, whatever
    // the Figma font metrics are.
    text.textAutoResize = "WIDTH_AND_HEIGHT";
  } else {
    // Multi-line: a wrapping box. Width is FIXED here (fill-width children
    // are stretched/grown by appendChildren); height follows the text.
    text.resizeWithoutConstraints(
      Math.max(0.01, rn.layout.width),
      Math.max(0.01, rn.layout.height),
    );
    text.textAutoResize = "HEIGHT";
  }
  text.name = textLayerName(rn);
  ctx.counts.texts++;
  return text;
}

async function appendChildren(
  parent: FrameNode | ComponentNode,
  rn: RenderNode,
  ctx: BuildContext,
): Promise<void> {
  for (const child of rn.children ?? []) {
    const node = await buildNode(child, ctx);
    if (!node) continue;
    parent.appendChild(node);
    if (rn.layout.mode === "none") {
      node.x = child.layout.x;
      node.y = child.layout.y;
    } else if (child.layout.absolute) {
      // CSS-absolute child of an autolayout parent: opt out of the flow
      // natively and keep the measured parent-relative offsets. (Works for
      // frames, texts, and INSTANCE children alike.)
      if ("layoutPositioning" in node) {
        node.layoutPositioning = "ABSOLUTE";
      }
      node.x = child.layout.x;
      node.y = child.layout.y;
    } else {
      if (child.layout.grow && "layoutGrow" in node) {
        node.layoutGrow = 1;
      }
      if (rn.layout.counterAlign === "stretch" && "layoutAlign" in node) {
        node.layoutAlign = "STRETCH";
      }
      // Multi-line text fills the autolayout parent's width: grow along a
      // horizontal parent's primary axis, stretch across a vertical one.
      if (child.type === "text" && child.text && child.text.fillWidth) {
        if (rn.layout.mode === "horizontal" && "layoutGrow" in node) {
          node.layoutGrow = 1;
        } else if ("layoutAlign" in node) {
          node.layoutAlign = "STRETCH";
        }
      }
    }
  }
}

async function buildNode(
  rn: RenderNode,
  ctx: BuildContext,
): Promise<SceneNode | undefined> {
  if (rn.type === "text" && rn.text) {
    return buildText(rn, ctx);
  }

  if (rn.type === "svg" && rn.svg) {
    try {
      const svgFrame = figma.createNodeFromSvg(rn.svg);
      svgFrame.name = rn.name;
      svgFrame.resizeWithoutConstraints(
        Math.max(0.01, rn.layout.width),
        Math.max(0.01, rn.layout.height),
      );
      ctx.counts.svgs++;
      return svgFrame;
    } catch (error) {
      ctx.warnings.push(
        `SVG "${rn.name}" could not be imported (${error instanceof Error ? error.message : String(error)}); skipped.`,
      );
      return undefined;
    }
  }

  if (rn.type === "childComponent" && rn.componentId) {
    const main = ctx.mains.get(rn.componentId);
    if (!main) {
      ctx.warnings.push(
        `No component main for "${rn.componentId}"; placed a placeholder frame.`,
      );
      const placeholder = figma.createFrame();
      placeholder.name = rn.name;
      placeholder.resizeWithoutConstraints(
        Math.max(0.01, rn.layout.width),
        Math.max(0.01, rn.layout.height),
      );
      placeholder.fills = [
        { type: "SOLID", color: { r: 0.8, g: 0.8, b: 0.8 } },
      ];
      return placeholder;
    }
    // Nested registered component: a native INSTANCE of its main (whose NAME is
    // the registry id, set in ensureMain). The declarative pull recovers the
    // registry id from `mainComponent`, so no per-node stamp is needed.
    const instance = main.createInstance();
    ctx.counts.instances++;
    return instance;
  }

  // frame | image (an image is a frame with an image fill). Slot components
  // serialize inline as a plain frame (static design at this level); the
  // declarative pull treats their contents like any other static subtree.
  const frame = figma.createFrame();
  frame.name = rn.name;
  applyLayout(frame, rn.layout);
  applyFrameVisuals(frame, rn, ctx);
  if (rn.type === "image") ctx.counts.images++;
  else ctx.counts.frames++;
  await appendChildren(frame, rn, ctx);
  return frame;
}

/** All nodes on the current page stamped with a designbook componentId. */
function findStamped(kind: string, componentId: string): SceneNode | undefined {
  const nodes = figma.currentPage.findAllWithCriteria({
    sharedPluginData: { namespace: NS, keys: ["componentId"] },
  });
  return nodes.find(
    (node) =>
      node.getSharedPluginData(NS, "componentId") === componentId &&
      node.getSharedPluginData(NS, "kind") === kind,
  );
}

/** Find-or-create the section that parks component mains. */
function ensureComponentsSection(): SectionNode {
  const sections = figma.currentPage.findAllWithCriteria({
    types: ["SECTION"],
  });
  const existing = sections.find(
    (section) => section.getSharedPluginData(NS, "kind") === "components-section",
  );
  if (existing) return existing;

  const section = figma.createSection();
  section.name = COMPONENTS_SECTION_NAME;
  section.setSharedPluginData(NS, "kind", "components-section");
  section.setSharedPluginData(NS, "componentId", "__designbook_components__");
  section.x = Math.round(figma.viewport.center.x + 1200);
  section.y = Math.round(figma.viewport.center.y);
  section.resizeWithoutConstraints(800, 600);
  return section;
}

/** Base property name from a Figma property key (`Name#12:0` → `Name`). */
function propBaseName(key: string): string {
  const hash = key.lastIndexOf("#");
  return hash === -1 ? key : key.slice(0, hash);
}

/**
 * Originates NATIVE Figma Component Properties for a component main's content
 * slots — today the only push-side slot signal is i18n text, authored as TEXT
 * properties named `i18n.<ns>.<key>` and wired to the driving text node via
 * `componentPropertyReferences`. The `#name` layer convention (textLayerName)
 * stays as the fallback, and the pull reads whichever is present. BOOLEAN /
 * INSTANCE_SWAP mapping is ready (see figmaComponentProps.ts) but has no
 * push-side signal yet.
 *
 * Feature-detected and defensively guarded: any unsupported API or per-slot
 * failure degrades to the layer-name fallback. NOTE: only verifiable against
 * live Figma desktop — no unit coverage of the figma.* wiring.
 */
function authorComponentProperties(
  component: ComponentNode,
  tree: RenderNode,
  ctx: BuildContext,
): void {
  const api = component as ComponentNode & {
    addComponentProperty?: (
      name: string,
      type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP",
      defaultValue: string | boolean,
    ) => string;
    deleteComponentProperty?: (name: string) => void;
  };
  if (typeof api.addComponentProperty !== "function") return;

  // Re-push: drop only the properties we previously managed (i18n.* names) so
  // re-adding them doesn't collide; user-authored properties are left intact.
  const existing = component.componentPropertyDefinitions;
  if (existing && typeof api.deleteComponentProperty === "function") {
    for (const key of Object.keys(existing)) {
      if (!isI18nSlotName(propBaseName(key))) continue;
      try {
        api.deleteComponentProperty(key);
      } catch {
        // ignore
      }
    }
  }

  const slots = collectMainSlots(tree);
  if (slots.length === 0) return;

  // Index TEXT descendants by their hash-stripped layer name (== slot name).
  const textsByName = new Map<string, TextNode>();
  for (const text of component.findAllWithCriteria({ types: ["TEXT"] })) {
    if (text.name.charAt(0) === "#") textsByName.set(text.name.slice(1), text);
  }

  for (const slot of slots) {
    const def = slotDescriptorToPropertyDef(slot);
    const aspect = slotReferenceAspect(slot.kind);
    try {
      const propId = api.addComponentProperty!(def.name, def.type, def.defaultValue);
      if (slot.kind === "text") {
        const target = textsByName.get(slot.name);
        if (target) {
          const refs: Record<string, string> = {};
          const current = target.componentPropertyReferences as Record<
            string,
            string
          > | null;
          if (current) {
            for (const refKey of Object.keys(current)) refs[refKey] = current[refKey];
          }
          refs[aspect] = propId;
          target.componentPropertyReferences =
            refs as typeof target.componentPropertyReferences;
        }
      }
    } catch (error) {
      ctx.warnings.push(
        `Component property "${def.name}" could not be authored (${error instanceof Error ? error.message : String(error)}); using the #name fallback.`,
      );
    }
  }
}

/**
 * Find-or-create the COMPONENT main for a nested component. Re-push keeps the
 * existing component node (stable id → instances elsewhere update) and
 * rebuilds its children from the new tree.
 */
async function ensureMain(
  componentId: string,
  tree: RenderNode,
  ctx: BuildContext,
): Promise<ComponentNode> {
  const existing = findStamped("main", componentId);
  if (existing && existing.type === "COMPONENT") {
    for (const child of existing.children.slice()) child.remove();
    applyLayout(existing, tree.layout);
    applyFrameVisuals(existing, tree, ctx);
    // The main's NAME is the registry id: the declarative pull reads it off
    // `instance.mainComponent` to identify the nested component.
    existing.name = componentId;
    await appendChildren(existing, tree, ctx);
    authorComponentProperties(existing, tree, ctx);
    return existing;
  }

  const built = await buildNode(tree, ctx);
  let frame: FrameNode;
  if (built && built.type === "FRAME") {
    frame = built;
  } else {
    // Non-frame root (svg/image edge case): wrap it so we can componentize.
    frame = figma.createFrame();
    frame.name = tree.name;
    frame.resizeWithoutConstraints(
      Math.max(0.01, tree.layout.width),
      Math.max(0.01, tree.layout.height),
    );
    if (built) frame.appendChild(built);
  }

  const section = ensureComponentsSection();
  const component = figma.createComponentFromNode(frame);
  // NAME = registry id (see re-push branch above): the pull recovers it from
  // `instance.mainComponent`. The componentId/kind stamp anchors re-push.
  component.name = componentId;
  component.setSharedPluginData(NS, "componentId", componentId);
  component.setSharedPluginData(NS, "kind", "main");
  section.appendChild(component);
  // Park mains left-to-right inside the section.
  let cursorX = 40;
  for (const child of section.children) {
    if (child !== component) cursorX = Math.max(cursorX, child.x + child.width + 40);
  }
  component.x = cursorX;
  component.y = 40;
  authorComponentProperties(component, tree, ctx);
  return component;
}

type RenderNodesParams = {
  tree: RenderTree;
  collection?: string;
};

async function renderNodes(params: RenderNodesParams): Promise<RenderNodesResult> {
  const tree = params.tree;
  if (!tree || !tree.root || typeof tree.componentId !== "string") {
    throw new Error("figma_render_nodes: params.tree is missing or malformed.");
  }

  const warnings: string[] = [];
  const collectionName =
    tree.meta?.collection ?? params.collection ?? DEFAULT_COLLECTION;

  const fonts = await resolveFonts(tree, warnings);
  const pushedMode = tree.meta?.mode;
  const { variables, modeId } = await resolveVariables(
    collectionName,
    pushedMode,
  );
  if (variables.size === 0) {
    warnings.push(
      `Variable collection "${collectionName}" not found; token values were baked in as raw values.`,
    );
  }

  const imageHashes = new Map<string, string>();
  for (const imageId of Object.keys(tree.images ?? {})) {
    try {
      const image = figma.createImage(
        figma.base64Decode(tree.images[imageId].base64),
      );
      imageHashes.set(imageId, image.hash);
    } catch (error) {
      warnings.push(
        `Image "${imageId}" could not be decoded (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  const ctx: BuildContext = {
    fonts,
    variables,
    modeId,
    refreshedVariables: new Set(),
    imageHashes,
    mains: new Map(),
    counts: { frames: 0, texts: 0, svgs: 0, images: 0, instances: 0 },
    warnings,
  };

  // 1. Component mains for nested registered components.
  for (const componentId of Object.keys(tree.childComponents ?? {})) {
    ctx.mains.set(
      componentId,
      await ensureMain(componentId, tree.childComponents[componentId].tree, ctx),
    );
  }

  // 2. Root frame: update in place when a previous push exists.
  const existingRoot = findStamped("root", tree.componentId);
  let root: FrameNode;
  let created = false;
  if (existingRoot && existingRoot.type === "FRAME") {
    root = existingRoot;
    for (const child of root.children.slice()) child.remove();
  } else {
    root = figma.createFrame();
    created = true;
    figma.currentPage.appendChild(root);
    root.x = Math.round(figma.viewport.center.x - tree.root.layout.width / 2);
    root.y = Math.round(figma.viewport.center.y - tree.root.layout.height / 2);
  }

  root.name = tree.componentName;
  applyLayout(root, tree.root.layout);
  applyFrameVisuals(root, tree.root, ctx);
  await appendChildren(root, tree.root, ctx);

  // The ONE authoritative marker (declarative pull, see readHtml.ts): a JSON
  // root stamp carrying the registry id + schema version + the RENDER
  // CONTEXT this push reflects (locale/theme/mode + other adapter dimension
  // values), so the pull can tell Pi which rendering produced the target.
  // componentId/kind are retained as the machine anchor for re-push
  // find-or-update targeting.
  const renderContext: PullRenderContext = {};
  if (tree.meta) {
    if (tree.meta.locale) renderContext.locale = tree.meta.locale;
    if (tree.meta.variant) renderContext.theme = tree.meta.variant;
    if (tree.meta.mode) renderContext.mode = tree.meta.mode;
    if (tree.meta.dimensions) renderContext.dimensions = tree.meta.dimensions;
  }
  root.setSharedPluginData(NS, "componentId", tree.componentId);
  root.setSharedPluginData(NS, "kind", "root");
  root.setSharedPluginData(
    NS,
    "root",
    formatRootMarker({
      component: tree.componentId,
      v: ROOT_MARKER_VERSION,
      render: renderContext,
    }),
  );

  if (created) {
    figma.currentPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([root]);
  }

  // Surface refreshed stale token values in the push notice (same channel as
  // the font-fallback warnings — FigmaSyncControls shows the count + text).
  if (ctx.refreshedVariables.size > 0) {
    const names: string[] = [];
    ctx.refreshedVariables.forEach((name) => names.push(name));
    warnings.push(
      `Refreshed ${names.length} stale token value(s) in Figma ("${collectionName}"${pushedMode ? `, mode "${pushedMode}"` : ""}): ${names.join(", ")}.`,
    );
  }

  return {
    nodeId: root.id,
    url: `https://figma.com/file/${figma.fileKey}?node-id=${encodeURIComponent(root.id)}`,
    created,
    counts: ctx.counts,
    warnings,
  };
}

export { renderNodes };
export type { RenderNodesParams, RenderNodesResult };
