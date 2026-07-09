/**
 * Pure Figma-node-snapshot → CSS mapping for the declarative "pull from
 * Figma" flow — the read-side mirror of the push pipeline
 * (ui/previewHost/figmaSerialize.ts → figmaRender.ts mappers →
 * figma-plugin/render.ts appliers). The plugin (figma-plugin/readHtml.ts)
 * builds a plain, serializable `FigmaNodeSnapshot` from the live `figma.*`
 * node — variable ids ALREADY resolved to names — and `figmaNodeToCss` maps
 * it to `{ style, tokens }` for the annotated-HTML target.
 *
 * Parity contract (see figmaReadCss.test.ts for the full table): every CSS
 * property the push side writes into a Figma node comes back here as the same
 * property — inline `style` when the value is raw, `tokens[<cssProp>]`
 * (→ `data-token-<cssProp>`) when a variable is bound. Properties push never
 * writes are NOT invented; a handful of designer-only Figma fields
 * (min/max sizing, text-decoration, text-transform, padding variable aliases,
 * `layoutPositioning: "ABSOLUTE"` inside autolayout) are additionally read
 * because a designer can author them in Figma even though push has no source
 * for them.
 *
 * Framework-free (no React/DOM/Node/figma) and ES2017-safe: compiled by the
 * node/ui tsconfigs AND by the Figma plugin's tsconfig — same pattern as
 * figmaHtml.ts / figmaRender.ts.
 */

import { rgbToHex, type Rgba } from "../../../config/color.ts";

// ---------------------------------------------------------------------------
// Snapshot shape (built by figma-plugin/readHtml.ts from the live node)
// ---------------------------------------------------------------------------

type SnapshotSolidPaint = {
  type: "SOLID";
  color: { r: number; g: number; b: number };
  /** Paint opacity (Figma `SolidPaint.opacity`); defaults to 1. */
  opacity?: number;
  /** Resolved NAME of the variable bound to the paint color, if any. */
  colorToken?: string;
};

type SnapshotGradientPaint = {
  type: "GRADIENT_LINEAR";
  /** Figma 2×3 affine `gradientTransform`. */
  gradientTransform: ReadonlyArray<ReadonlyArray<number>>;
  stops: ReadonlyArray<{ position: number; color: Rgba }>;
};

/** Image / unsupported paints — carried so the mapper skips them knowingly. */
type SnapshotOtherPaint = { type: "OTHER" };

type SnapshotPaint =
  | SnapshotSolidPaint
  | SnapshotGradientPaint
  | SnapshotOtherPaint;

type SnapshotEffect = {
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: Rgba;
  offset: { x: number; y: number };
  /** Blur radius (Figma `Effect.radius`). */
  radius: number;
  spread?: number;
};

/** Number-field variable bindings, ids already resolved to variable NAMES. */
type SnapshotBoundTokens = {
  itemSpacing?: string;
  /** Push binds all four corners to ONE variable; topLeftRadius is the probe. */
  topLeftRadius?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
};

type SnapshotLayoutMode = "NONE" | "HORIZONTAL" | "VERTICAL";
type SnapshotSizingMode = "FIXED" | "AUTO";
type SnapshotLayoutAlign = "INHERIT" | "STRETCH" | "MIN" | "CENTER" | "MAX";

type FigmaNodeSnapshot = {
  /** TEXT node: fills map to `color`, the font/text fields apply. */
  isText?: boolean;
  width?: number;
  height?: number;
  /**
   * Position relative to the PARENT's top-left corner (Figma `node.x`/`y` are
   * always parent-relative for frame children, including absolute-positioned
   * children of autolayout frames). Read back as `left`/`top` when the node is
   * absolutely positioned (NONE-layout parent, or `layoutPositioning`
   * ABSOLUTE); ignored otherwise (autolayout owns the position).
   */
  x?: number;
  y?: number;
  /** Figma's per-child opt-out of autolayout flow (designer-set). */
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;

  // Autolayout (the node's own frame layout).
  layoutMode?: SnapshotLayoutMode;
  primaryAxisSizingMode?: SnapshotSizingMode;
  counterAxisSizingMode?: SnapshotSizingMode;
  primaryAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  counterAxisAlignItems?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  itemSpacing?: number;
  counterAxisSpacing?: number | null;
  layoutWrap?: "NO_WRAP" | "WRAP";
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;

  // Child-in-autolayout-parent fields.
  layoutGrow?: number;
  layoutAlign?: SnapshotLayoutAlign;
  /**
   * `layoutAlign` of each VISIBLE in-flow child (drives the stretch-default
   * collapse; absolute-positioned children are excluded — they opt out of the
   * autolayout flow, but their presence still matters for `position:
   * relative`, see `hasAbsoluteChildren`).
   */
  childLayoutAligns?: string[];
  /**
   * The node contains ≥1 absolutely-positioned VISIBLE child: any child at
   * all under a NONE-layout frame (push writes CSS-absolute subtrees as
   * layoutMode NONE + child x/y — render.ts appendChildren L466-468), or a
   * `layoutPositioning: "ABSOLUTE"` child under autolayout. The node then
   * emits `position: relative` so pulled `left`/`top` resolve against it.
   */
  hasAbsoluteChildren?: boolean;

  fills?: SnapshotPaint[];
  strokes?: SnapshotPaint[];
  strokeWeight?: number;
  /** [topLeft, topRight, bottomRight, bottomLeft]. */
  radii?: [number, number, number, number];
  effects?: SnapshotEffect[];
  opacity?: number;
  clipsContent?: boolean;

  // TEXT fields (mixed values are omitted by the adapter).
  fontName?: { family: string; style: string };
  fontSize?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  letterSpacingPx?: number;
  letterSpacingPercent?: number;
  textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textAutoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE";
  textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
  textCase?:
    | "ORIGINAL"
    | "UPPER"
    | "LOWER"
    | "TITLE"
    | "SMALL_CAPS"
    | "SMALL_CAPS_FORCED";

  boundTokens?: SnapshotBoundTokens;
};

/** How the PARENT lays this node out (undefined for the pulled root). */
type ParentLayoutContext = {
  layoutMode: SnapshotLayoutMode;
  /**
   * The parent's counter axis resolved to CSS-default stretch (Figma MIN +
   * every child STRETCH — how push encodes `align-items: stretch`): children
   * then skip the redundant `align-self: stretch`.
   */
  stretchChildren?: boolean;
};

type ReadCssResult = {
  style: Record<string, string>;
  tokens: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function px(value: number): string {
  return `${round2(value)}px`;
}

/** Rgba → `#rrggbb`, or `rgba(r, g, b, a)` when translucent. */
function cssColor(color: Rgba): string {
  const a = color.a === undefined ? 1 : color.a;
  if (a >= 1) return rgbToHex(color);
  const to255 = (channel: number) =>
    Math.round(Math.min(1, Math.max(0, channel)) * 255);
  const alpha = Math.round(a * 10000) / 10000;
  return `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${alpha})`;
}

function solidRgba(paint: SnapshotSolidPaint): Rgba {
  return {
    r: paint.color.r,
    g: paint.color.g,
    b: paint.color.b,
    a: paint.opacity === undefined ? 1 : paint.opacity,
  };
}

function firstSolid(
  paints: SnapshotPaint[] | undefined,
): SnapshotSolidPaint | undefined {
  if (!paints) return undefined;
  for (const paint of paints) {
    if (paint.type === "SOLID") return paint;
  }
  return undefined;
}

/**
 * GRADIENT_LINEAR → `linear-gradient(<angle>deg, <stops>)`. Inverts
 * render.ts's `gradientTransformForAngle` (L221-229): the transform's first
 * row is [cos, sin, …] of `(angle - 90)°`, so `angle = atan2(m01, m00) + 90`.
 */
function gradientToCss(paint: SnapshotGradientPaint): string {
  const m = paint.gradientTransform;
  const m00 = m[0] ? m[0][0] : 1;
  const m01 = m[0] ? m[0][1] : 0;
  let angle = (Math.atan2(m01, m00) * 180) / Math.PI + 90;
  angle = ((angle % 360) + 360) % 360;
  const stops = paint.stops
    .map((stop) => `${cssColor(stop.color)} ${round2(stop.position * 100)}%`)
    .join(", ");
  return `linear-gradient(${round2(angle)}deg, ${stops})`;
}

/** Effects → CSS `box-shadow` list (`inset` prefix for inner shadows). */
function effectsToBoxShadow(effects: SnapshotEffect[]): string {
  return effects
    .map((effect) => {
      const inset = effect.type === "INNER_SHADOW" ? "inset " : "";
      const spread = effect.spread === undefined ? 0 : effect.spread;
      return `${inset}${px(effect.offset.x)} ${px(effect.offset.y)} ${px(effect.radius)} ${px(spread)} ${cssColor(effect.color)}`;
    })
    .join(", ");
}

/** [top, right, bottom, left] px values → shortest CSS shorthand. */
function sidesShorthand(sides: [number, number, number, number]): string {
  const [top, right, bottom, left] = sides;
  if (top === right && top === bottom && top === left) return px(top);
  if (top === bottom && right === left) return `${px(top)} ${px(right)}`;
  return `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`;
}

// ---------------------------------------------------------------------------
// Font style name → CSS weight (reverse of figmaRender's cssWeightToFigmaStyle)
// ---------------------------------------------------------------------------

/** Ordered most-specific-first so `semibold` never matches plain `bold`. */
const STYLE_WEIGHTS: Array<[string, number]> = [
  ["extralight", 200],
  ["ultralight", 200],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["semibold", 600],
  ["demibold", 600],
  ["hairline", 100],
  ["regular", 400],
  ["normal", 400],
  ["medium", 500],
  ["light", 300],
  ["black", 900],
  ["heavy", 900],
  ["bold", 700],
  ["thin", 100],
];

/**
 * Figma font style name → `{ weight, italic }` — the reverse of
 * `cssWeightToFigmaStyle` (figmaRender.ts): `"SemiBold Italic"` →
 * `{ weight: 600, italic: true }`. Unknown names fall back to 400.
 */
function figmaStyleToCssWeight(styleName: string): {
  weight: number;
  italic: boolean;
} {
  const normalized = styleName.toLowerCase().replace(/[\s-]+/g, "");
  const italic = normalized.indexOf("italic") !== -1;
  const base = normalized.replace(/italic/g, "");
  for (const [name, weight] of STYLE_WEIGHTS) {
    if (base.indexOf(name) !== -1) return { weight, italic };
  }
  return { weight: 400, italic };
}

// ---------------------------------------------------------------------------
// Sizing semantics (FIXED / HUG / FILL)
// ---------------------------------------------------------------------------

type Sizing = "fixed" | "hug" | "fill";

function isAutolayout(node: FigmaNodeSnapshot): boolean {
  return node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL";
}

/** How the node sizes horizontally (see render.ts applyLayout/appendChildren). */
function horizontalSizing(
  node: FigmaNodeSnapshot,
  parent: ParentLayoutContext | undefined,
): Sizing {
  if (node.isText) {
    if (node.textAutoResize === "WIDTH_AND_HEIGHT") return "hug";
  } else if (
    node.layoutMode === "HORIZONTAL" &&
    node.primaryAxisSizingMode === "AUTO"
  ) {
    return "hug";
  } else if (
    node.layoutMode === "VERTICAL" &&
    node.counterAxisSizingMode === "AUTO"
  ) {
    return "hug";
  }
  if (parent) {
    if (parent.layoutMode === "HORIZONTAL" && (node.layoutGrow || 0) > 0) {
      return "fill";
    }
    if (parent.layoutMode === "VERTICAL" && node.layoutAlign === "STRETCH") {
      return "fill";
    }
  }
  return "fixed";
}

/** How the node sizes vertically. */
function verticalSizing(
  node: FigmaNodeSnapshot,
  parent: ParentLayoutContext | undefined,
): Sizing {
  if (node.isText) {
    if (
      node.textAutoResize === "WIDTH_AND_HEIGHT" ||
      node.textAutoResize === "HEIGHT"
    ) {
      return "hug";
    }
  } else if (
    node.layoutMode === "VERTICAL" &&
    node.primaryAxisSizingMode === "AUTO"
  ) {
    return "hug";
  } else if (
    node.layoutMode === "HORIZONTAL" &&
    node.counterAxisSizingMode === "AUTO"
  ) {
    return "hug";
  }
  if (parent) {
    if (parent.layoutMode === "VERTICAL" && (node.layoutGrow || 0) > 0) {
      return "fill";
    }
    if (parent.layoutMode === "HORIZONTAL" && node.layoutAlign === "STRETCH") {
      return "fill";
    }
  }
  return "fixed";
}

/**
 * True when the node's counter axis is CSS-default stretch: Figma
 * counterAxisAlignItems MIN (how push maps `align-items: stretch/normal`)
 * with every visible child layoutAlign STRETCH (appendChildren L473-475).
 * The pull then omits `align-items` (CSS default) and children omit
 * `align-self: stretch`.
 */
function isStretchDefault(node: FigmaNodeSnapshot): boolean {
  if (!isAutolayout(node)) return false;
  const counter = node.counterAxisAlignItems;
  if (counter !== undefined && counter !== "MIN") return false;
  const aligns = node.childLayoutAligns;
  if (!aligns || aligns.length === 0) return false;
  return aligns.every((align) => align === "STRETCH");
}

// ---------------------------------------------------------------------------
// The mapper
// ---------------------------------------------------------------------------

/**
 * Maps one Figma node snapshot to `{ style, tokens }`:
 * - `style`: inline CSS for the annotated-HTML target.
 * - `tokens`: cssProp → variable name (emitted as `data-token-<cssProp>`);
 *   a token-bound property is NEVER duplicated in `style`.
 */
function figmaNodeToCss(
  node: FigmaNodeSnapshot,
  parent?: ParentLayoutContext,
): ReadCssResult {
  const style: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const bound = node.boundTokens || {};

  // Absolutely positioned: every child of a NONE-layout parent (push writes
  // CSS-absolute subtrees that way — appendChildren L466-468 sets x/y), or a
  // designer-set layoutPositioning ABSOLUTE inside autolayout. Never the
  // pulled root (parent undefined). Figma x/y are parent-relative, matching
  // CSS left/top against the parent's `position: relative` (Figma has no
  // parent padding/border offset on NONE frames — applyLayout skips padding
  // for mode "none").
  const absolute =
    parent !== undefined &&
    (parent.layoutMode === "NONE" || node.layoutPositioning === "ABSOLUTE") &&
    node.x !== undefined &&
    node.y !== undefined;

  // --- Fill → color (text) / background (frame); gradients → background-image.
  const fill = firstSolid(node.fills);
  if (fill) {
    const prop = node.isText ? "color" : "background";
    if (fill.colorToken) tokens[prop] = fill.colorToken;
    else style[prop] = cssColor(solidRgba(fill));
  }
  if (!node.isText && node.fills) {
    const gradients = node.fills.filter(
      (paint): paint is SnapshotGradientPaint => paint.type === "GRADIENT_LINEAR",
    );
    if (gradients.length > 0) {
      style["background-image"] = gradients.map(gradientToCss).join(", ");
    }
  }

  // --- Stroke → border-color + border-width + border-style (INSIDE stroke,
  // written by applyFrameVisuals L367-371 from a uniform CSS border).
  const stroke = firstSolid(node.strokes);
  if (stroke) {
    if (stroke.colorToken) tokens["border-color"] = stroke.colorToken;
    else style["border-color"] = cssColor(solidRgba(stroke));
    if (node.strokeWeight !== undefined && node.strokeWeight > 0) {
      style["border-width"] = px(node.strokeWeight);
    }
    style["border-style"] = "solid";
  }

  // --- Corner radius (uniform token binding via the topLeftRadius alias —
  // push binds all four corners to one variable, L375-382).
  if (node.radii) {
    const [tl, tr, br, bl] = node.radii;
    const uniform = tl === tr && tl === br && tl === bl;
    if (uniform && bound.topLeftRadius) {
      tokens["border-radius"] = bound.topLeftRadius;
    } else if (uniform) {
      if (tl > 0) style["border-radius"] = px(tl);
    } else {
      style["border-radius"] = `${px(tl)} ${px(tr)} ${px(br)} ${px(bl)}`;
    }
  }

  // --- Autolayout → display/flex-direction/wrap/gap/padding/alignment.
  if (isAutolayout(node)) {
    const horizontal = node.layoutMode === "HORIZONTAL";
    style.display = "flex";
    style["flex-direction"] = horizontal ? "row" : "column";
    if (node.layoutWrap === "WRAP") style["flex-wrap"] = "wrap";

    // Gap: itemSpacing (primary axis) + counterAxisSpacing (wrap cross axis).
    const main = node.itemSpacing || 0;
    if (bound.itemSpacing) {
      tokens.gap = bound.itemSpacing;
    } else {
      const cross =
        node.layoutWrap === "WRAP" &&
        node.counterAxisSpacing !== null &&
        node.counterAxisSpacing !== undefined
          ? node.counterAxisSpacing
          : main;
      if (cross !== main) {
        // CSS shorthand is `row-gap column-gap`; Figma's counterAxisSpacing is
        // the cross-axis gap (rows for a wrapping horizontal frame).
        style.gap = horizontal ? `${px(cross)} ${px(main)}` : `${px(main)} ${px(cross)}`;
      } else if (main > 0) {
        style.gap = px(main);
      }
    }

    // Padding: per-side variable aliases win; leftovers stay numeric.
    const pads: [number, number, number, number] = [
      node.paddingTop || 0,
      node.paddingRight || 0,
      node.paddingBottom || 0,
      node.paddingLeft || 0,
    ];
    const padAliases = [
      bound.paddingTop,
      bound.paddingRight,
      bound.paddingBottom,
      bound.paddingLeft,
    ];
    if (padAliases.some((alias) => alias !== undefined)) {
      const props = ["padding-top", "padding-right", "padding-bottom", "padding-left"];
      for (let i = 0; i < 4; i++) {
        const alias = padAliases[i];
        if (alias) tokens[props[i]] = alias;
        else if (pads[i] !== 0) style[props[i]] = px(pads[i]);
      }
    } else if (pads.some((pad) => pad !== 0)) {
      style.padding = sidesShorthand(pads);
    }

    // justify-content (primaryAxisAlignItems, applyLayout L307-319);
    // MIN is the CSS default (flex-start) and stays implicit.
    switch (node.primaryAxisAlignItems) {
      case "CENTER":
        style["justify-content"] = "center";
        break;
      case "MAX":
        style["justify-content"] = "flex-end";
        break;
      case "SPACE_BETWEEN":
        style["justify-content"] = "space-between";
        break;
      default:
        break;
    }

    // align-items (counterAxisAlignItems, applyLayout L320-336). Figma MIN is
    // ambiguous: push maps BOTH `flex-start` and `stretch` to MIN, marking
    // stretch per-child via layoutAlign — the stretch-default collapse keeps
    // CSS's implicit `stretch` implicit.
    switch (node.counterAxisAlignItems) {
      case "CENTER":
        style["align-items"] = "center";
        break;
      case "MAX":
        style["align-items"] = "flex-end";
        break;
      case "BASELINE":
        style["align-items"] = "baseline";
        break;
      default: {
        const aligns = node.childLayoutAligns;
        if (aligns && aligns.length > 0 && !isStretchDefault(node)) {
          style["align-items"] = "flex-start";
        }
        break;
      }
    }
  }

  // --- Position: absolute children carry left/top; a parent of absolute
  // children anchors them with `position: relative` (unless itself absolute —
  // an absolutely positioned element is already a containing block).
  if (node.hasAbsoluteChildren) style.position = "relative";
  if (absolute) {
    style.position = "absolute";
    style.left = px(node.x as number);
    style.top = px(node.y as number);
  }

  // --- Sizing: FIXED → px, HUG → omitted, FILL → flex-grow / align-self.
  // Absolute children opt out of the parent's flow: fill semantics
  // (layoutGrow / layoutAlign) don't apply, so size against no parent.
  const flowParent = absolute ? undefined : parent;
  const sizingH = horizontalSizing(node, flowParent);
  const sizingV = verticalSizing(node, flowParent);
  if (sizingH === "fixed" && node.width !== undefined && node.width > 0) {
    style.width = px(node.width);
  }
  if (sizingV === "fixed" && node.height !== undefined && node.height > 0) {
    style.height = px(node.height);
  }
  if (flowParent) {
    const growAxis =
      (flowParent.layoutMode === "HORIZONTAL" && sizingH === "fill") ||
      (flowParent.layoutMode === "VERTICAL" && sizingV === "fill");
    const stretchAxis =
      (flowParent.layoutMode === "HORIZONTAL" && sizingV === "fill") ||
      (flowParent.layoutMode === "VERTICAL" && sizingH === "fill");
    if (growAxis && (node.layoutGrow || 0) > 0) style["flex-grow"] = "1";
    if (stretchAxis && !flowParent.stretchChildren) {
      style["align-self"] = "stretch";
    }
  }
  if (node.minWidth !== undefined && node.minWidth !== null) {
    style["min-width"] = px(node.minWidth);
  }
  if (node.maxWidth !== undefined && node.maxWidth !== null) {
    style["max-width"] = px(node.maxWidth);
  }
  if (node.minHeight !== undefined && node.minHeight !== null) {
    style["min-height"] = px(node.minHeight);
  }
  if (node.maxHeight !== undefined && node.maxHeight !== null) {
    style["max-height"] = px(node.maxHeight);
  }

  // --- Effects → box-shadow (applyFrameVisuals L390-405).
  if (node.effects && node.effects.length > 0) {
    style["box-shadow"] = effectsToBoxShadow(node.effects);
  }

  // --- Misc frame visuals.
  if (node.opacity !== undefined && node.opacity < 1) {
    // Figma stores opacity as float32 (0.9 → 0.8999999761581421); round to 4
    // decimals, matching `cssColor`'s paint-alpha rounding above.
    style.opacity = String(Math.round(node.opacity * 10000) / 10000);
  }
  if (node.clipsContent) style.overflow = "hidden";

  // --- Text styles (buildText L415-455; decoration/case are designer-only).
  if (node.isText) {
    if (node.fontName) {
      style["font-family"] = node.fontName.family;
      const { weight, italic } = figmaStyleToCssWeight(node.fontName.style);
      if (weight !== 400) style["font-weight"] = String(weight);
      if (italic) style["font-style"] = "italic";
    }
    if (node.fontSize !== undefined) style["font-size"] = px(node.fontSize);
    if (node.lineHeightPx !== undefined) {
      style["line-height"] = px(node.lineHeightPx);
    } else if (node.lineHeightPercent !== undefined) {
      style["line-height"] = `${round2(node.lineHeightPercent)}%`;
    }
    if (node.letterSpacingPx !== undefined && node.letterSpacingPx !== 0) {
      style["letter-spacing"] = px(node.letterSpacingPx);
    } else if (
      node.letterSpacingPercent !== undefined &&
      node.letterSpacingPercent !== 0
    ) {
      style["letter-spacing"] = `${Math.round(node.letterSpacingPercent * 100) / 10000}em`;
    }
    switch (node.textAlignHorizontal) {
      case "CENTER":
        style["text-align"] = "center";
        break;
      case "RIGHT":
        style["text-align"] = "right";
        break;
      case "JUSTIFIED":
        style["text-align"] = "justify";
        break;
      default:
        break; // LEFT is the CSS default.
    }
    if (node.textDecoration === "UNDERLINE") {
      style["text-decoration"] = "underline";
    } else if (node.textDecoration === "STRIKETHROUGH") {
      style["text-decoration"] = "line-through";
    }
    if (node.textCase === "UPPER") style["text-transform"] = "uppercase";
    else if (node.textCase === "LOWER") style["text-transform"] = "lowercase";
    else if (node.textCase === "TITLE") style["text-transform"] = "capitalize";
  }

  return { style, tokens };
}

export { figmaNodeToCss, figmaStyleToCssWeight, isStretchDefault };
export type {
  FigmaNodeSnapshot,
  ParentLayoutContext,
  ReadCssResult,
  SnapshotBoundTokens,
  SnapshotEffect,
  SnapshotGradientPaint,
  SnapshotPaint,
  SnapshotSolidPaint,
};
