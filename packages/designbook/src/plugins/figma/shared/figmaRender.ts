/**
 * Pure CSS-computed-style → Figma render-tree mapping for the "push component
 * to Figma" flow. The browser serializer (ui/…/figmaSerialize.ts) walks the
 * live DOM and calls these mappers to build a `RenderTree`; the Figma plugin
 * (figma-plugin/render.ts) consumes the same types to build native nodes.
 *
 * Framework-free (no React/DOM/Node) and ES2017-safe, because it is compiled
 * both by the node/ui tsconfigs and by the Figma plugin's tsconfig and bundled
 * into the plugin's `code.js`.
 */

import { parseCssColor, type Rgba } from "../../../config/color.ts";

/** A fill: solid (optionally bound to a theme token), gradient, or image. */
type RenderPaint =
  | { kind: "solid"; color: Rgba; tokenName?: string }
  | {
      kind: "gradient";
      stops: Array<{ position: number; color: Rgba }>;
      /** CSS gradient angle in degrees (0 = to top, clockwise). */
      angle: number;
    }
  | { kind: "image"; imageId: string };

/**
 * Geometry + autolayout for one node. `x`/`y` are relative to the parent node;
 * all values are canvas-zoom-corrected CSS pixels.
 */
type RenderLayout = {
  mode: "none" | "horizontal" | "vertical";
  x: number;
  y: number;
  width: number;
  height: number;
  gap?: number;
  counterGap?: number;
  wrap?: boolean;
  /** [top, right, bottom, left]. */
  padding?: [number, number, number, number];
  primaryAlign?: "min" | "center" | "max" | "space-between";
  counterAlign?: "min" | "center" | "max" | "baseline" | "stretch";
  /** This node stretches along its PARENT's primary axis (flex-grow > 0). */
  grow?: boolean;
  /**
   * The source was a `*-reverse` flex direction: the caller must reverse the
   * children it feeds the node (layout math is otherwise identical).
   */
  reverse?: boolean;
  /**
   * Autolayout frame hugs its content along the horizontal axis (Figma
   * sizing mode AUTO on width; height stays FIXED — CSS often pins it). Set
   * by the serializer for content-sized flex frames whose children are all
   * auto-width texts (badges, buttons), so Figma font metrics can't overflow
   * the frame. The differ suppresses width noise on hug frames.
   */
  hug?: boolean;
  /**
   * Autolayout frame hugs its content along the VERTICAL axis (Figma sizing
   * mode AUTO on height). Set by the serializer when the measured height is
   * CONTENT-DETERMINED — forcing `height: auto` leaves it unchanged — so an
   * unchanged design round-trips with no fixed height for Pi to hardcode.
   */
  hugHeight?: boolean;
  /**
   * The source element was CSS `position: absolute`/`fixed`. Under a
   * mode:"none" parent the x/y placement already covers it; under an
   * AUTOLAYOUT parent render.ts opts the node out of the flow natively via
   * `layoutPositioning: "ABSOLUTE"` + x/y.
   */
  absolute?: boolean;
};

type RenderText = {
  /** Rendered characters, i18n markers stripped. */
  characters: string;
  i18n?: { namespace: string; key: string };
  font: {
    family: string;
    weight: number;
    italic: boolean;
    size: number;
    lineHeightPx?: number;
    letterSpacing?: number;
  };
  color: Rgba;
  colorToken?: string;
  align: "left" | "center" | "right" | "justified";
  /**
   * Single-line in the browser → Figma `textAutoResize: WIDTH_AND_HEIGHT`
   * (hug width; can never wrap). `layout.width/height` are advisory only.
   */
  autoWidth?: boolean;
  /**
   * Multi-line flex child of an autolayout parent → fill the parent's width
   * (layoutGrow 1 on the primary axis / layoutAlign STRETCH on the counter
   * axis) with `textAutoResize: HEIGHT`. Mutually exclusive with `autoWidth`.
   */
  fillWidth?: boolean;
};

type RenderEffect = {
  kind: "drop-shadow" | "inner-shadow";
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: Rgba;
};

type RenderStroke = { color: Rgba; weight: number; tokenName?: string };

type RenderNodeType = "frame" | "text" | "svg" | "image" | "childComponent";

type RenderNode = {
  /** Path-serial id within its tree: "r", "r.0", "r.0.2", … */
  dbId: string;
  type: RenderNodeType;
  name: string;
  layout: RenderLayout;
  fills?: RenderPaint[];
  stroke?: RenderStroke;
  /** Uniform, or [topLeft, topRight, bottomRight, bottomLeft]. */
  cornerRadius?: number | [number, number, number, number];
  radiusToken?: string;
  gapToken?: string;
  effects?: RenderEffect[];
  opacity?: number;
  clipsContent?: boolean;
  text?: RenderText;
  /** Serialized `<svg>` outerHTML with computed presentation inlined. */
  svg?: string;
  /** Registry id of the nested component (type "childComponent"). */
  componentId?: string;
  /**
   * Registry id of the nested SLOT component this frame came from (type
   * "frame"). Slot components receive parent-authored children, so instead of
   * COMPONENT main + opaque INSTANCE their subtree is serialized inline as a
   * plain frame — fully diffable at this level. The plugin stamps
   * pluginData componentId + kind:"slot" from this.
   */
  slotComponentId?: string;
  children?: RenderNode[];
};

type RenderOccurrence = {
  dbId: string;
  layout: RenderLayout;
  textOverrides: Array<{ path: string; characters: string }>;
};

type RenderChildComponent = {
  tree: RenderNode;
  occurrences: RenderOccurrence[];
};

type RenderTreeMeta = {
  locale: string;
  variant: string;
  mode: string;
  pushedAt: string;
  hash: string;
  /** Figma variable collection to bind tokens against. */
  collection?: string;
  /**
   * OTHER active adapter dimension values at push time (flags etc.), keyed
   * by dimension id (locale/variant/mode are first-class above). Stamped
   * into the root marker so the pull can tell Pi which rendering produced
   * the target.
   */
  dimensions?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Root marker (sharedPluginData designbook.root) — written by
// figma-plugin/render.ts on push, read back by figma-plugin/readHtml.ts on
// pull. The ONE per-component hidden marker (see the spec).
// ---------------------------------------------------------------------------

/**
 * The render context a push stamps into the root marker: which SINGLE
 * rendering of the component the pushed frame (and therefore any later pull
 * target) reflects. Lets Pi distinguish sample content and prop/flag-driven
 * presence from actual design edits.
 */
type PullRenderContext = {
  locale?: string;
  /** Theme variant (the workbench "Theme" selector). */
  theme?: string;
  /** Theme mode (light/dark/…). */
  mode?: string;
  /** Other adapter dimension values, dimension id → value (flags etc.). */
  dimensions?: Record<string, string>;
};

/**
 * Marker schema version. v1 readers ignore unknown fields, so adding
 * `render` (2026-07) did NOT bump the version — bump only when a field's
 * MEANING changes or a reader must reject older markers.
 */
const ROOT_MARKER_VERSION = 1;

type RootMarker = {
  /** designbook registry id of the component. */
  component: string;
  v: number;
  render?: PullRenderContext;
};

/** Builds the root-marker JSON string a push stamps (render.ts). */
function formatRootMarker(marker: RootMarker): string {
  const out: RootMarker = { component: marker.component, v: marker.v };
  const render = marker.render;
  if (render) {
    const compact: PullRenderContext = {};
    if (render.locale !== undefined) compact.locale = render.locale;
    if (render.theme !== undefined) compact.theme = render.theme;
    if (render.mode !== undefined) compact.mode = render.mode;
    if (render.dimensions && Object.keys(render.dimensions).length > 0) {
      compact.dimensions = render.dimensions;
    }
    if (Object.keys(compact).length > 0) out.render = compact;
  }
  return JSON.stringify(out);
}

/**
 * Parses a root-marker JSON string (readHtml.ts). Returns undefined for
 * malformed/older payloads — pull then simply omits the context line.
 */
function parseRootMarker(raw: string): RootMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.component !== "string" || typeof record.v !== "number") {
    return undefined;
  }
  const marker: RootMarker = { component: record.component, v: record.v };
  const render = record.render;
  if (render !== null && typeof render === "object") {
    const source = render as Record<string, unknown>;
    const out: PullRenderContext = {};
    if (typeof source.locale === "string") out.locale = source.locale;
    if (typeof source.theme === "string") out.theme = source.theme;
    if (typeof source.mode === "string") out.mode = source.mode;
    if (source.dimensions !== null && typeof source.dimensions === "object") {
      const dims: Record<string, string> = {};
      const sourceDims = source.dimensions as Record<string, unknown>;
      for (const key of Object.keys(sourceDims)) {
        if (typeof sourceDims[key] === "string") {
          dims[key] = sourceDims[key] as string;
        }
      }
      if (Object.keys(dims).length > 0) out.dimensions = dims;
    }
    if (Object.keys(out).length > 0) marker.render = out;
  }
  return marker;
}

type RenderTree = {
  componentId: string;
  componentName: string;
  images: Record<string, { base64: string; mime: string }>;
  root: RenderNode;
  childComponents: Record<string, RenderChildComponent>;
  meta: RenderTreeMeta;
};

/** Plain computed-style record (subset of `getComputedStyle` as strings). */
type StyleRecord = Record<string, string>;

type Rect = { x: number; y: number; width: number; height: number };

function num(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mapPrimaryAlign(
  justifyContent: string | undefined,
): RenderLayout["primaryAlign"] {
  switch (justifyContent) {
    case "center":
      return "center";
    case "flex-end":
    case "end":
      return "max";
    case "space-between":
    case "space-around":
    case "space-evenly":
      return "space-between";
    default:
      return "min"; // flex-start / start / normal / stretch
  }
}

function mapCounterAlign(
  alignItems: string | undefined,
): RenderLayout["counterAlign"] {
  switch (alignItems) {
    case "center":
      return "center";
    case "flex-end":
    case "end":
      return "max";
    case "baseline":
      return "baseline";
    case "stretch":
    case "normal":
      return "stretch";
    default:
      return "min"; // flex-start / start
  }
}

/**
 * Maps an element's computed style + measured rects to a `RenderLayout`.
 * `display: flex|inline-flex` becomes horizontal/vertical autolayout (a
 * `*-reverse` flex-direction sets `reverse` so the caller reverses children);
 * anything else is `mode: "none"` with children absolutely positioned at their
 * measured offsets. Sizes are always FIXED, taken from the rects.
 */
function flexToLayout(
  style: StyleRecord,
  rect: Rect,
  parentRect: Rect,
): RenderLayout {
  const layout: RenderLayout = {
    mode: "none",
    x: round2(rect.x - parentRect.x),
    y: round2(rect.y - parentRect.y),
    width: round2(rect.width),
    height: round2(rect.height),
  };

  if (num(style["flex-grow"]) > 0) layout.grow = true;

  const position = style["position"] ?? "";
  if (position === "absolute" || position === "fixed") layout.absolute = true;

  const display = style["display"] ?? "";
  const isFlex = display === "flex" || display === "inline-flex";
  if (isFlex) {
    const direction = style["flex-direction"] ?? "row";
    const vertical = direction.indexOf("column") === 0;
    layout.mode = vertical ? "vertical" : "horizontal";
    if (direction.indexOf("-reverse") !== -1) layout.reverse = true;

    // Along the primary axis the relevant gap is column-gap for rows and
    // row-gap for columns; the counter gap only matters when wrapping.
    const columnGap = num(style["column-gap"]);
    const rowGap = num(style["row-gap"]);
    const gap = vertical ? rowGap : columnGap;
    const counterGap = vertical ? columnGap : rowGap;
    if (gap > 0) layout.gap = round2(gap);
    if (counterGap > 0) layout.counterGap = round2(counterGap);

    if ((style["flex-wrap"] ?? "").indexOf("wrap") === 0) layout.wrap = true;

    layout.primaryAlign = mapPrimaryAlign(style["justify-content"]);
    layout.counterAlign = mapCounterAlign(style["align-items"]);
  }

  const padding: [number, number, number, number] = [
    round2(num(style["padding-top"])),
    round2(num(style["padding-right"])),
    round2(num(style["padding-bottom"])),
    round2(num(style["padding-left"])),
  ];
  if (padding.some((value) => value !== 0)) layout.padding = padding;

  return layout;
}

/**
 * Decides whether a NON-FLEX (block) container can push as a VERTICAL
 * autolayout frame: every IN-FLOW child must be a full-content-width block,
 * stacked in document order with uniform gaps, starting at the padding
 * origin (1px subpixel tolerance). Returns the stack gap, or null when the
 * shape doesn't hold (the container then stays mode:"none").
 *
 * Why: Figma NONE frames can neither HUG their content nor host
 * `layoutPositioning: "ABSOLUTE"` children — upgrading a clean block stack
 * (e.g. the ProductCard image+badges wrapper: one full-width child + an
 * absolute badge) is what lets a content-sized positioning wrapper
 * round-trip with no fixed height. `rects` are the in-flow children's
 * absolute rects; absolute/hidden children are the caller's to exclude.
 */
function blockStackGap(
  rects: Rect[],
  padding: [number, number, number, number] | undefined,
  rect: Rect,
): { gap: number } | null {
  if (rects.length === 0) return null;
  const pad = padding ?? [0, 0, 0, 0];
  const left = rect.x + pad[3];
  const top = rect.y + pad[0];
  const width = rect.width - pad[1] - pad[3];
  let gap: number | undefined;
  let prevBottom: number | undefined;
  for (const r of rects) {
    if (Math.abs(r.x - left) > 1 || Math.abs(r.width - width) > 1) return null;
    if (prevBottom === undefined) {
      if (Math.abs(r.y - top) > 1) return null;
    } else {
      const g = r.y - prevBottom;
      if (g < -0.5) return null; // overlap → not a stack
      if (gap === undefined) gap = g;
      else if (Math.abs(g - gap) > 1) return null; // uneven margins
    }
    prevBottom = r.y + r.height;
  }
  return { gap: gap !== undefined && gap > 0.5 ? round2(gap) : 0 };
}

/** Splits a multi-value CSS list on top-level commas (ignores parens). */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/**
 * Parses a computed `box-shadow` list (`getComputedStyle` puts the color
 * first: `rgb(...) 0px 4px 6px 0px [inset]`, but author-order `0 4px 6px
 * rgb()` also parses) into shadow effects. `inset` → inner-shadow.
 */
function parseBoxShadow(value: string): RenderEffect[] {
  const text = value.trim();
  if (text === "" || text === "none") return [];

  const effects: RenderEffect[] = [];
  for (const part of splitTopLevel(text, ",")) {
    let rest = part;
    let inset = false;
    if (/\binset\b/.test(rest)) {
      inset = true;
      rest = rest.replace(/\binset\b/, " ");
    }

    let color: Rgba | null = null;
    const colorMatch =
      /(rgba?\([^)]*\)|oklch\([^)]*\)|#[0-9a-fA-F]{3,8})/.exec(rest);
    if (colorMatch) {
      color = parseCssColor(colorMatch[1]);
      rest = rest.replace(colorMatch[1], " ");
    }

    const lengths = rest
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => num(token));
    if (lengths.length < 2) continue;

    effects.push({
      kind: inset ? "inner-shadow" : "drop-shadow",
      x: lengths[0],
      y: lengths[1],
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color: color ?? { r: 0, g: 0, b: 0, a: 0.25 },
    });
  }
  return effects;
}

/**
 * Parses one computed `linear-gradient(...)` into a gradient paint. Only the
 * deg-angle + color-stop form `getComputedStyle` produces is supported;
 * unsupported inputs return null.
 */
function parseLinearGradient(value: string): RenderPaint | null {
  const match = /^linear-gradient\(([\s\S]*)\)$/.exec(value.trim());
  if (!match) return null;

  const args = splitTopLevel(match[1], ",");
  if (args.length === 0) return null;

  let angle = 180; // CSS default: "to bottom".
  let stopArgs = args;
  const first = args[0];
  const angleMatch = /^(-?[\d.]+)deg$/.exec(first);
  if (angleMatch) {
    angle = Number.parseFloat(angleMatch[1]);
    stopArgs = args.slice(1);
  } else if (first.indexOf("to ") === 0) {
    const directions: Record<string, number> = {
      "to top": 0,
      "to right": 90,
      "to bottom": 180,
      "to left": 270,
      "to top right": 45,
      "to right top": 45,
      "to bottom right": 135,
      "to right bottom": 135,
      "to bottom left": 225,
      "to left bottom": 225,
      "to top left": 315,
      "to left top": 315,
    };
    const mapped = directions[first.replace(/\s+/g, " ")];
    if (mapped === undefined) return null;
    angle = mapped;
    stopArgs = args.slice(1);
  }

  type RawStop = { color: Rgba; position?: number };
  const raw: RawStop[] = [];
  for (const stopArg of stopArgs) {
    const colorMatch =
      /(rgba?\([^)]*\)|oklch\([^)]*\)|#[0-9a-fA-F]{3,8}|transparent)/.exec(
        stopArg,
      );
    if (!colorMatch) return null;
    const color = parseCssColor(colorMatch[1]);
    if (!color) return null;
    const positionMatch = /(-?[\d.]+)%/.exec(
      stopArg.replace(colorMatch[1], " "),
    );
    raw.push({
      color,
      position: positionMatch
        ? Number.parseFloat(positionMatch[1]) / 100
        : undefined,
    });
  }
  if (raw.length < 2) return null;

  // Fill in unspecified stop positions by even interpolation (CSS rules,
  // simplified: first defaults 0, last defaults 1, gaps spread evenly).
  if (raw[0].position === undefined) raw[0].position = 0;
  if (raw[raw.length - 1].position === undefined) {
    raw[raw.length - 1].position = 1;
  }
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i].position !== undefined) continue;
    let j = i + 1;
    while (raw[j].position === undefined) j++;
    const start = raw[i - 1].position as number;
    const end = raw[j].position as number;
    const steps = j - (i - 1);
    for (let k = i; k < j; k++) {
      raw[k].position = start + ((end - start) * (k - (i - 1))) / steps;
    }
  }

  return {
    kind: "gradient",
    angle,
    stops: raw.map((stop) => ({
      position: Math.min(1, Math.max(0, stop.position as number)),
      color: stop.color,
    })),
  };
}

type RenderVisuals = {
  fills?: RenderPaint[];
  stroke?: RenderStroke;
  cornerRadius?: number | [number, number, number, number];
  effects?: RenderEffect[];
  opacity?: number;
  clipsContent?: boolean;
};

/**
 * Extracts the paint/stroke/radius/effect/overflow visuals from an element's
 * computed style. Background images are NOT handled here (the serializer owns
 * image fetching); only `background-color` and `linear-gradient` images are.
 */
function styleToVisuals(style: StyleRecord): RenderVisuals {
  const visuals: RenderVisuals = {};

  const fills: RenderPaint[] = [];
  const backgroundImage = style["background-image"] ?? "";
  if (backgroundImage !== "" && backgroundImage !== "none") {
    for (const layer of splitTopLevel(backgroundImage, ",")) {
      const gradient = parseLinearGradient(layer);
      if (gradient) fills.push(gradient);
    }
  }
  const backgroundColor = parseCssColor(style["background-color"] ?? "");
  if (backgroundColor && backgroundColor.a > 0) {
    // CSS paints the color under image layers; Figma paints array bottom-up,
    // so the color goes first.
    fills.unshift({ kind: "solid", color: backgroundColor });
  }
  if (fills.length > 0) visuals.fills = fills;

  // Uniform border → INSIDE stroke. Non-uniform borders are dropped (Figma
  // frames have a single stroke weight per paint in this mapping).
  const widths = [
    num(style["border-top-width"]),
    num(style["border-right-width"]),
    num(style["border-bottom-width"]),
    num(style["border-left-width"]),
  ];
  const styles = [
    style["border-top-style"] ?? "none",
    style["border-right-style"] ?? "none",
    style["border-bottom-style"] ?? "none",
    style["border-left-style"] ?? "none",
  ];
  if (
    widths[0] > 0 &&
    widths.every((width) => width === widths[0]) &&
    styles.every((borderStyle) => borderStyle === styles[0]) &&
    styles[0] !== "none" &&
    styles[0] !== "hidden"
  ) {
    const color = parseCssColor(style["border-top-color"] ?? "");
    if (color && color.a > 0) {
      visuals.stroke = { color, weight: round2(widths[0]) };
    }
  }

  const radii: [number, number, number, number] = [
    num(style["border-top-left-radius"]),
    num(style["border-top-right-radius"]),
    num(style["border-bottom-right-radius"]),
    num(style["border-bottom-left-radius"]),
  ];
  if (radii.some((radius) => radius > 0)) {
    visuals.cornerRadius = radii.every((radius) => radius === radii[0])
      ? round2(radii[0])
      : [round2(radii[0]), round2(radii[1]), round2(radii[2]), round2(radii[3])];
  }

  const effects = parseBoxShadow(style["box-shadow"] ?? "");
  if (effects.length > 0) visuals.effects = effects;

  const opacity = style["opacity"];
  if (opacity !== undefined && opacity !== "" && num(opacity) < 1) {
    visuals.opacity = num(opacity);
  }

  const overflow = style["overflow"] ?? "";
  if (
    overflow.indexOf("hidden") !== -1 ||
    overflow.indexOf("clip") !== -1 ||
    overflow.indexOf("auto") !== -1 ||
    overflow.indexOf("scroll") !== -1
  ) {
    visuals.clipsContent = true;
  }

  return visuals;
}

type TextSizing = { autoWidth: boolean; fillWidth: boolean };

/**
 * Decides how a text node should size in Figma from its browser measurements.
 * Single-line (measured height ≤ 1.5× the line height; falls back to
 * 1.2×font-size when line-height is "normal") → hug (`autoWidth`), which can
 * never wrap regardless of Figma font metrics. Multi-line → needs a wrapping
 * box: fill the parent's width when it is an autolayout frame (`fillWidth`),
 * otherwise the serializer keeps a FIXED, safety-padded width.
 */
function decideTextSizing(
  measuredHeight: number,
  fontSize: number,
  lineHeightPx: number | undefined,
  parentMode: RenderLayout["mode"],
): TextSizing {
  const line =
    lineHeightPx !== undefined && lineHeightPx > 0
      ? lineHeightPx
      : fontSize * 1.2;
  if (measuredHeight <= line * 1.5) {
    return { autoWidth: true, fillWidth: false };
  }
  return { autoWidth: false, fillWidth: parentMode !== "none" };
}

const WEIGHT_NAMES: Array<[number, string[]]> = [
  [100, ["Thin", "Hairline"]],
  [200, ["ExtraLight", "Extra Light", "UltraLight", "Ultra Light"]],
  [300, ["Light"]],
  [400, ["Regular", "Normal"]],
  [500, ["Medium"]],
  [600, ["SemiBold", "Semi Bold", "DemiBold", "Demi Bold"]],
  [700, ["Bold"]],
  [800, ["ExtraBold", "Extra Bold", "UltraBold", "Ultra Bold"]],
  [900, ["Black", "Heavy"]],
];

/**
 * CSS numeric font-weight (+ italic) → ordered Figma font-style-name
 * candidates, e.g. `600 → ["SemiBold", "Semi Bold", …]`, `(700, true) →
 * ["Bold Italic", …]`. The weight snaps to the nearest of the 9 CSS buckets.
 */
function cssWeightToFigmaStyle(weight: number, italic: boolean): string[] {
  let best = WEIGHT_NAMES[3]; // 400
  let bestDistance = Infinity;
  for (const bucket of WEIGHT_NAMES) {
    const distance = Math.abs(bucket[0] - weight);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = bucket;
    }
  }
  if (!italic) return best[1].slice();
  return best[1].map((name) =>
    name === "Regular" || name === "Normal" ? "Italic" : `${name} Italic`,
  );
}

/** Stable stringify: object keys sorted recursively, arrays in order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Stable content hash of a render tree (FNV-1a over a key-sorted stringify),
 * excluding the volatile `meta.pushedAt`/`meta.hash` fields. Two pushes of an
 * unchanged component produce the same hash.
 */
function hashRenderTree(tree: RenderTree): string {
  const stableMeta = {
    locale: tree.meta.locale,
    variant: tree.meta.variant,
    mode: tree.meta.mode,
    collection: tree.meta.collection,
    dimensions: tree.meta.dimensions,
  };
  const text = stableStringify({ ...tree, meta: stableMeta });

  let hashValue = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hashValue ^= text.charCodeAt(i);
    // FNV prime multiply, kept in uint32 via shifts.
    hashValue =
      (hashValue +
        ((hashValue << 1) >>> 0) +
        ((hashValue << 4) >>> 0) +
        ((hashValue << 7) >>> 0) +
        ((hashValue << 8) >>> 0) +
        ((hashValue << 24) >>> 0)) >>>
      0;
  }
  return hashValue.toString(16).padStart(8, "0");
}

export {
  blockStackGap,
  cssWeightToFigmaStyle,
  decideTextSizing,
  flexToLayout,
  formatRootMarker,
  hashRenderTree,
  parseBoxShadow,
  parseLinearGradient,
  parseRootMarker,
  ROOT_MARKER_VERSION,
  styleToVisuals,
};
export type {
  PullRenderContext,
  RenderChildComponent,
  RenderEffect,
  RenderLayout,
  RenderNode,
  RenderNodeType,
  RenderOccurrence,
  RenderPaint,
  RenderStroke,
  RenderText,
  RenderTree,
  RenderTreeMeta,
  RenderVisuals,
  RootMarker,
  StyleRecord,
  TextSizing,
};
