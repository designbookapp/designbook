/**
 * Two-way parity tests for the declarative pull's CSS readback
 * (figmaReadCss.ts). Round-trip shape:
 *
 *   CSS computed style
 *     → push mappers  (flexToLayout / styleToVisuals — figmaRender.ts, pure)
 *     → simulated Figma node snapshot (simulateFrameNode / simulateTextNode
 *       below — faithful, line-cited replicas of figma-plugin/render.ts
 *       applyLayout L271-337, appendChildren L457-487, applyFrameVisuals
 *       L355-413, buildText L415-455)
 *     → pull mapper   (figmaNodeToCss — pure)
 *     → the original CSS back.
 *
 * KNOWN-LOSSY exceptions (parity with push is the spec — push itself drops
 * these, so pull cannot recover them):
 * - Children of non-autolayout parents come back ABSOLUTE (`position:
 *   absolute; left/top` from Figma x/y, parent `position: relative`) even
 *   when the original CSS was static flow — Figma NONE layout is free
 *   positioning, so absolute is the faithful readback.
 * - `*-reverse` flex directions: push reverses the children instead
 *   (figmaSerialize L616-619), so pull reads plain row/column.
 * - Non-uniform border widths: push drops them (figmaRender L459-476).
 * - Font fallback lists: push keeps the first family only (firstFontFamily).
 * - `padding` comes back as the shortest shorthand, `background-color` as
 *   `background`, colors as hex/rgba() — value-equal, not string-equal.
 * - CSS defaults stay implicit on readback: `justify-content: flex-start`,
 *   `align-items: stretch` (the MIN + all-children-STRETCH encoding),
 *   `font-weight: 400`, `text-align: left`, `letter-spacing: 0`.
 * - Image fills / SVG content have no CSS readback.
 */

import { describe, expect, it } from "vitest";
import {
  cssWeightToFigmaStyle,
  flexToLayout,
  parseBoxShadow,
  parseLinearGradient,
  styleToVisuals,
  type RenderLayout,
  type RenderPaint,
  type RenderText,
  type RenderVisuals,
  type StyleRecord,
} from "./figmaRender.ts";
import { parseCssColor, type Rgba } from "./color.ts";
import {
  figmaNodeToCss,
  figmaStyleToCssWeight,
  isStretchDefault,
  type FigmaNodeSnapshot,
  type ParentLayoutContext,
  type SnapshotPaint,
} from "./figmaReadCss.ts";
import { htmlNodeToString } from "./figmaHtml.ts";

// ---------------------------------------------------------------------------
// render.ts simulation (the non-pure half of the push, replicated for tests)
// ---------------------------------------------------------------------------

/** Replica of render.ts `gradientTransformForAngle` (L221-229). */
function gradientTransformForAngle(angleDeg: number): number[][] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [cos, sin, 0.5 - cos / 2 - sin / 2],
    [-sin, cos, 0.5 + sin / 2 - cos / 2],
  ];
}

/** Replica of render.ts `solidPaint` (L201-218): color + opacity (+ binding). */
function solidSnapshot(color: Rgba, tokenName?: string): SnapshotPaint {
  return {
    type: "SOLID",
    color: { r: color.r, g: color.g, b: color.b },
    opacity: color.a,
    colorToken: tokenName,
  };
}

function paintSnapshot(paint: RenderPaint): SnapshotPaint {
  if (paint.kind === "solid") return solidSnapshot(paint.color, paint.tokenName);
  if (paint.kind === "gradient") {
    // render.ts buildPaint (L235-249).
    return {
      type: "GRADIENT_LINEAR",
      gradientTransform: gradientTransformForAngle(paint.angle),
      stops: paint.stops.map((stop) => ({
        position: stop.position,
        color: stop.color,
      })),
    };
  }
  return { type: "OTHER" };
}

type ParentSim = {
  mode: RenderLayout["mode"];
  counterAlign?: RenderLayout["counterAlign"];
};

type ChildSim = { grow?: boolean; fillWidthText?: boolean; absolute?: boolean };

type SimFrame = {
  layout: RenderLayout;
  visuals?: RenderVisuals;
  radiusToken?: string;
  gapToken?: string;
  /** The parent frame's layout — drives layoutGrow/layoutAlign stamps. */
  parent?: ParentSim;
  /** This frame's children — drives childLayoutAligns. */
  children?: ChildSim[];
};

/**
 * What a Figma FRAME looks like after render.ts applied a RenderNode to it:
 * applyLayout (L271-337) + applyFrameVisuals (L355-413) + the child-side
 * stamps of appendChildren (L457-487).
 */
function simulateFrameNode(sim: SimFrame): FigmaNodeSnapshot {
  const { layout } = sim;
  const visuals = sim.visuals ?? {};
  const snap: FigmaNodeSnapshot = {
    width: layout.width,
    height: layout.height,
  };

  // applyLayout L275-337.
  if (layout.mode === "none") {
    snap.layoutMode = "NONE";
  } else {
    snap.layoutMode = layout.mode === "horizontal" ? "HORIZONTAL" : "VERTICAL";
    snap.primaryAxisSizingMode = "FIXED";
    snap.counterAxisSizingMode = "FIXED";
    snap.itemSpacing = layout.gap ?? 0;
    snap.layoutWrap = "NO_WRAP";
    snap.counterAxisSpacing = null;
    if (layout.wrap && snap.layoutMode === "HORIZONTAL") {
      snap.layoutWrap = "WRAP";
      snap.counterAxisSpacing = layout.counterGap ?? layout.gap ?? 0;
    }
    const padding = layout.padding ?? [0, 0, 0, 0];
    snap.paddingTop = padding[0];
    snap.paddingRight = padding[1];
    snap.paddingBottom = padding[2];
    snap.paddingLeft = padding[3];
    if (layout.hug) {
      if (snap.layoutMode === "HORIZONTAL") snap.primaryAxisSizingMode = "AUTO";
      else snap.counterAxisSizingMode = "AUTO";
    }
    // applyLayout hugHeight branch: content-determined height → vertical hug.
    if (layout.hugHeight) {
      if (snap.layoutMode === "HORIZONTAL") snap.counterAxisSizingMode = "AUTO";
      else snap.primaryAxisSizingMode = "AUTO";
    }
    snap.primaryAxisAlignItems =
      layout.primaryAlign === "center"
        ? "CENTER"
        : layout.primaryAlign === "max"
          ? "MAX"
          : layout.primaryAlign === "space-between"
            ? "SPACE_BETWEEN"
            : "MIN";
    snap.counterAxisAlignItems =
      layout.counterAlign === "center"
        ? "CENTER"
        : layout.counterAlign === "max"
          ? "MAX"
          : layout.counterAlign === "baseline"
            ? snap.layoutMode === "HORIZONTAL"
              ? "BASELINE"
              : "MIN"
            : "MIN"; // min + stretch both anchor at MIN (L320-336).
  }

  // appendChildren child-side stamps (L466-475): a mode-"none" parent sets
  // the child's x/y (L466-468); autolayout parents stamp grow/align.
  if (sim.parent) {
    if (sim.parent.mode === "none") {
      snap.x = layout.x;
      snap.y = layout.y;
    } else if (layout.absolute) {
      // appendChildren absolute branch: layoutPositioning ABSOLUTE + x/y,
      // no grow/align stamps (the child is out of the flow).
      snap.layoutPositioning = "ABSOLUTE";
      snap.x = layout.x;
      snap.y = layout.y;
    } else {
      snap.layoutGrow = layout.grow ? 1 : 0;
      snap.layoutAlign =
        sim.parent.counterAlign === "stretch" ? "STRETCH" : "INHERIT";
    }
  }

  // What appendChildren stamps on each of THIS frame's children (L473-484).
  if (sim.children) {
    // readHtml.ts excludes ABSOLUTE children from the stretch-default probe.
    const inFlow = sim.children.filter((child) => !child.absolute);
    snap.childLayoutAligns = inFlow.map((child) =>
      layout.counterAlign === "stretch" ||
      (child.fillWidthText && layout.mode === "vertical")
        ? "STRETCH"
        : "INHERIT",
    );
    // readHtml.ts flags absolute children: every child of a NONE-layout
    // container (the push wrote x/y — see above), or layoutPositioning
    // ABSOLUTE children under autolayout.
    if (layout.mode === "none" && sim.children.length > 0) {
      snap.hasAbsoluteChildren = true;
    } else if (layout.mode !== "none" && inFlow.length !== sim.children.length) {
      snap.hasAbsoluteChildren = true;
    }
  }

  // applyFrameVisuals L360-413.
  if (visuals.fills && visuals.fills.length > 0) {
    snap.fills = visuals.fills.map(paintSnapshot);
  }
  if (visuals.stroke) {
    snap.strokes = [solidSnapshot(visuals.stroke.color, visuals.stroke.tokenName)];
    snap.strokeWeight = visuals.stroke.weight;
  }
  if (typeof visuals.cornerRadius === "number") {
    const radius = visuals.cornerRadius;
    snap.radii = [radius, radius, radius, radius];
    if (sim.radiusToken) {
      snap.boundTokens = { ...snap.boundTokens, topLeftRadius: sim.radiusToken };
    }
  } else if (visuals.cornerRadius) {
    snap.radii = visuals.cornerRadius;
  }
  if (visuals.effects && visuals.effects.length > 0) {
    snap.effects = visuals.effects.map((effect) => ({
      type: effect.kind === "inner-shadow" ? "INNER_SHADOW" : "DROP_SHADOW",
      color: effect.color,
      offset: { x: effect.x, y: effect.y },
      radius: Math.max(0, effect.blur),
      spread: effect.spread,
    }));
  }
  if (visuals.opacity !== undefined) snap.opacity = visuals.opacity;
  snap.clipsContent = visuals.clipsContent ?? false;
  if (layout.mode !== "none" && sim.gapToken) {
    snap.boundTokens = { ...snap.boundTokens, itemSpacing: sim.gapToken };
  }

  return snap;
}

type SimText = {
  text: RenderText;
  layout: { width: number; height: number; x?: number; y?: number };
  parent?: ParentSim;
};

/**
 * What a Figma TEXT node looks like after render.ts buildText (L415-455) +
 * the appendChildren stamps (L466-484, incl. the fillWidth grow/stretch).
 */
function simulateTextNode(sim: SimText): FigmaNodeSnapshot {
  const spec = sim.text;
  const snap: FigmaNodeSnapshot = {
    isText: true,
    width: sim.layout.width,
    height: sim.layout.height,
    fontName: {
      family: spec.font.family,
      // resolveFonts picks the first cssWeightToFigmaStyle candidate (L130-137).
      style: cssWeightToFigmaStyle(spec.font.weight, spec.font.italic)[0],
    },
    fontSize: spec.font.size,
    fills: [solidSnapshot(spec.color, spec.colorToken)],
    textAlignHorizontal:
      spec.align === "center"
        ? "CENTER"
        : spec.align === "right"
          ? "RIGHT"
          : spec.align === "justified"
            ? "JUSTIFIED"
            : "LEFT",
    textAutoResize: spec.autoWidth ? "WIDTH_AND_HEIGHT" : "HEIGHT",
  };
  if (spec.font.lineHeightPx !== undefined) snap.lineHeightPx = spec.font.lineHeightPx;
  if (spec.font.letterSpacing !== undefined) {
    snap.letterSpacingPx = spec.font.letterSpacing;
  }
  if (sim.parent && sim.parent.mode !== "none") {
    snap.layoutGrow = 0;
    snap.layoutAlign = sim.parent.counterAlign === "stretch" ? "STRETCH" : "INHERIT";
    if (spec.fillWidth) {
      if (sim.parent.mode === "horizontal") snap.layoutGrow = 1;
      else snap.layoutAlign = "STRETCH";
    }
  } else if (sim.parent && sim.parent.mode === "none") {
    // appendChildren L466-468: mode-"none" parents position children at x/y.
    if (sim.layout.x !== undefined) snap.x = sim.layout.x;
    if (sim.layout.y !== undefined) snap.y = sim.layout.y;
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Round-trip harness
// ---------------------------------------------------------------------------

const RECT = { x: 0, y: 0, width: 240, height: 120 };

type PushPullOptions = Omit<SimFrame, "layout" | "visuals"> & {
  rect?: { x: number; y: number; width: number; height: number };
  /** The parent's rect (drives x/y offsets under a mode-"none" parent). */
  parentRect?: { x: number; y: number; width: number; height: number };
  /** attachTokens equivalents (figmaSerialize L270-295). */
  fillToken?: string;
  strokeToken?: string;
  /**
   * The serializer's content-determined-height inference (isContentHeight,
   * DOM-measured): forcing `height: auto` left the measured height
   * unchanged, so the frame pushes with `layout.hugHeight`.
   */
  hugHeight?: boolean;
};

/** CSS record → push mappers → simulated node → pull mapper. */
function pushPull(
  css: StyleRecord,
  opts: PushPullOptions = {},
): { style: Record<string, string>; tokens: Record<string, string> } {
  const rect = opts.rect ?? RECT;
  const layout = flexToLayout(css, rect, opts.parentRect ?? rect);
  if (opts.hugHeight) layout.hugHeight = true;
  const visuals = styleToVisuals(css);
  if (opts.fillToken && visuals.fills) {
    for (const fill of visuals.fills) {
      if (fill.kind === "solid") fill.tokenName = opts.fillToken;
    }
  }
  if (opts.strokeToken && visuals.stroke) visuals.stroke.tokenName = opts.strokeToken;
  const snap = simulateFrameNode({ ...opts, layout, visuals });
  const parent: ParentLayoutContext | undefined = opts.parent
    ? opts.parent.mode === "none"
      ? { layoutMode: "NONE" }
      : {
          layoutMode: opts.parent.mode === "horizontal" ? "HORIZONTAL" : "VERTICAL",
          stretchChildren: opts.parent.counterAlign === "stretch",
        }
    : undefined;
  return figmaNodeToCss(snap, parent);
}

// ---------------------------------------------------------------------------
// Font weight reverse mapping
// ---------------------------------------------------------------------------

describe("figmaStyleToCssWeight", () => {
  it("inverts cssWeightToFigmaStyle for every weight bucket, upright and italic", () => {
    for (const weight of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      for (const italic of [false, true]) {
        const styleName = cssWeightToFigmaStyle(weight, italic)[0];
        expect(figmaStyleToCssWeight(styleName)).toEqual({ weight, italic });
      }
    }
  });

  it("handles spaced and unknown style names", () => {
    expect(figmaStyleToCssWeight("Semi Bold")).toEqual({ weight: 600, italic: false });
    expect(figmaStyleToCssWeight("Extra Bold Italic")).toEqual({
      weight: 800,
      italic: true,
    });
    expect(figmaStyleToCssWeight("Italic")).toEqual({ weight: 400, italic: true });
    expect(figmaStyleToCssWeight("Condensed")).toEqual({ weight: 400, italic: false });
  });
});

// ---------------------------------------------------------------------------
// Frame round-trips
// ---------------------------------------------------------------------------

describe("figmaNodeToCss — frame round-trip", () => {
  it("plain block: background, radius, opacity, overflow, fixed size", () => {
    const { style, tokens } = pushPull({
      display: "block",
      "background-color": "rgb(255, 255, 255)",
      "border-top-left-radius": "8px",
      "border-top-right-radius": "8px",
      "border-bottom-right-radius": "8px",
      "border-bottom-left-radius": "8px",
      opacity: "0.5",
      overflow: "hidden",
    });
    expect(tokens).toEqual({});
    expect(style).toEqual({
      background: "#ffffff",
      "border-radius": "8px",
      opacity: "0.5",
      overflow: "hidden",
      width: "240px",
      height: "120px",
    });
  });

  it("flex row: direction, gap, padding shorthand, centered axes", () => {
    const { style } = pushPull({
      display: "flex",
      "flex-direction": "row",
      "column-gap": "8px",
      "justify-content": "center",
      "align-items": "center",
      "padding-top": "12px",
      "padding-right": "16px",
      "padding-bottom": "12px",
      "padding-left": "16px",
    });
    expect(style).toEqual({
      display: "flex",
      "flex-direction": "row",
      gap: "8px",
      "justify-content": "center",
      "align-items": "center",
      padding: "12px 16px",
      width: "240px",
      height: "120px",
    });
  });

  it("flex column: space-between + flex-end + asymmetric padding", () => {
    const { style } = pushPull({
      display: "flex",
      "flex-direction": "column",
      "row-gap": "4px",
      "justify-content": "space-between",
      "align-items": "flex-end",
      "padding-top": "4px",
      "padding-right": "8px",
      "padding-bottom": "12px",
      "padding-left": "16px",
    });
    expect(style).toEqual({
      display: "flex",
      "flex-direction": "column",
      gap: "4px",
      "justify-content": "space-between",
      "align-items": "flex-end",
      padding: "4px 8px 12px 16px",
      width: "240px",
      height: "120px",
    });
  });

  it("align-items stretch collapses back to the CSS default (omitted)", () => {
    // Push encodes stretch as counterAxisAlignItems MIN + every child
    // layoutAlign STRETCH (render.ts L334-336 + L473-475).
    const { style } = pushPull(
      { display: "flex", "flex-direction": "column", "align-items": "normal" },
      { children: [{}, {}] },
    );
    expect(style["align-items"]).toBeUndefined();
  });

  it("align-items flex-start comes back explicit (not the CSS default)", () => {
    const { style } = pushPull(
      { display: "flex", "flex-direction": "column", "align-items": "flex-start" },
      { children: [{}, {}] },
    );
    expect(style["align-items"]).toBe("flex-start");
  });

  it("baseline alignment on a horizontal frame", () => {
    const { style } = pushPull({
      display: "flex",
      "flex-direction": "row",
      "align-items": "baseline",
    });
    expect(style["align-items"]).toBe("baseline");
  });

  it("flex-wrap with a distinct cross-axis gap", () => {
    const { style } = pushPull({
      display: "flex",
      "flex-direction": "row",
      "flex-wrap": "wrap",
      "column-gap": "8px",
      "row-gap": "4px",
    });
    expect(style["flex-wrap"]).toBe("wrap");
    // CSS shorthand is `row-gap column-gap`.
    expect(style.gap).toBe("4px 8px");
  });

  it("uniform border round-trips width, style, and color", () => {
    const { style } = pushPull({
      "border-top-width": "1px",
      "border-right-width": "1px",
      "border-bottom-width": "1px",
      "border-left-width": "1px",
      "border-top-style": "solid",
      "border-right-style": "solid",
      "border-bottom-style": "solid",
      "border-left-style": "solid",
      "border-top-color": "rgb(229, 229, 229)",
    });
    expect(style["border-width"]).toBe("1px");
    expect(style["border-style"]).toBe("solid");
    expect(style["border-color"]).toBe("#e5e5e5");
  });

  it("per-corner radii round-trip as a 4-value shorthand", () => {
    const { style } = pushPull({
      "border-top-left-radius": "8px",
      "border-top-right-radius": "8px",
      "border-bottom-right-radius": "0px",
      "border-bottom-left-radius": "0px",
    });
    expect(style["border-radius"]).toBe("8px 8px 0px 0px");
  });

  it("box-shadow list round-trips through the push parser", () => {
    const css: StyleRecord = {
      "box-shadow":
        "rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.06) 0px 2px 4px 0px inset",
    };
    const visuals = styleToVisuals(css);
    const { style } = pushPull(css);
    expect(style["box-shadow"]).toBe(
      "0px 4px 6px -1px rgba(0, 0, 0, 0.1), inset 0px 2px 4px 0px rgba(0, 0, 0, 0.06)",
    );
    // True round-trip: re-pushing the pulled value yields identical effects.
    expect(parseBoxShadow(style["box-shadow"])).toEqual(visuals.effects);
  });

  it("linear-gradient fill round-trips through the push parser", () => {
    const css: StyleRecord = {
      "background-image": "linear-gradient(135deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)",
    };
    const { style } = pushPull(css);
    expect(style["background-image"]).toBe(
      "linear-gradient(135deg, #ff0000 0%, #0000ff 100%)",
    );
    expect(parseLinearGradient(style["background-image"])).toEqual(
      parseLinearGradient(css["background-image"]),
    );
  });

  it("solid color under a gradient keeps both background layers", () => {
    const { style } = pushPull({
      "background-color": "rgb(23, 23, 23)",
      "background-image": "linear-gradient(180deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)",
    });
    expect(style.background).toBe("#171717");
    expect(style["background-image"]).toBe(
      "linear-gradient(180deg, #ff0000 0%, #0000ff 100%)",
    );
  });

  it("translucent colors come back as rgba()", () => {
    const { style } = pushPull({
      "background-color": "rgba(0, 0, 0, 0.5)",
    });
    expect(style.background).toBe("rgba(0, 0, 0, 0.5)");
    expect(parseCssColor(style.background)).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// Sizing semantics: FIXED / HUG / FILL
// ---------------------------------------------------------------------------

describe("figmaNodeToCss — sizing", () => {
  it("hug frame (all-auto-width-text children) omits the hugged axis", () => {
    // figmaSerialize sets layout.hug for content-sized flex frames (L622-632);
    // applyLayout makes the width axis AUTO (L299-305).
    const layout = flexToLayout(
      { display: "flex", "flex-direction": "row", "column-gap": "4px" },
      RECT,
      RECT,
    );
    layout.hug = true;
    const { style } = figmaNodeToCss(simulateFrameNode({ layout }));
    expect(style.width).toBeUndefined();
    expect(style.height).toBe("120px");
  });

  it("hug-height frame (content-determined height) omits height", () => {
    // Bug B: the serializer pushes content-determined heights as HUG
    // (layout.hugHeight -> sizing mode AUTO), so an unchanged design pulls
    // with no fixed height for Pi to hardcode.
    const { style } = pushPull(
      { display: "flex", "flex-direction": "row", "column-gap": "4px" },
      { hugHeight: true },
    );
    expect(style.height).toBeUndefined();
    expect(style.width).toBe("240px"); // width inference unchanged
  });

  it("flex-grow child fills the parent's primary axis", () => {
    const { style } = pushPull(
      { display: "block", "flex-grow": "1" },
      { parent: { mode: "horizontal", counterAlign: "min" } },
    );
    expect(style["flex-grow"]).toBe("1");
    expect(style.width).toBeUndefined();
    expect(style.height).toBe("120px");
  });

  it("stretch child in a stretch-default parent stays implicit", () => {
    const { style } = pushPull(
      { display: "block" },
      { parent: { mode: "vertical", counterAlign: "stretch" } },
    );
    expect(style["align-self"]).toBeUndefined();
    expect(style.width).toBeUndefined(); // FILL, not fixed
    expect(style.height).toBe("120px");
  });

  it("stretch child of a non-stretch parent keeps align-self", () => {
    const layout = flexToLayout({ display: "block" }, RECT, RECT);
    const snap = simulateFrameNode({
      layout,
      parent: { mode: "vertical", counterAlign: "min" },
    });
    snap.layoutAlign = "STRETCH"; // e.g. designer-set FILL width in Figma
    const { style } = figmaNodeToCss(snap, {
      layoutMode: "VERTICAL",
      stretchChildren: false,
    });
    expect(style["align-self"]).toBe("stretch");
    expect(style.width).toBeUndefined();
  });

  it("designer-set min/max sizing reads back (no push source)", () => {
    const snap = simulateFrameNode({
      layout: flexToLayout({ display: "block" }, RECT, RECT),
    });
    snap.minWidth = 100;
    snap.maxWidth = 400;
    snap.minHeight = null;
    snap.maxHeight = null;
    const { style } = figmaNodeToCss(snap);
    expect(style["min-width"]).toBe("100px");
    expect(style["max-width"]).toBe("400px");
    expect(style["min-height"]).toBeUndefined();
    expect(style["max-height"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Token bindings (boundVariables → data-token-<cssProp>)
// ---------------------------------------------------------------------------

describe("figmaNodeToCss — token bindings", () => {
  it("bound variables come back as tokens and are NOT duplicated in style", () => {
    const { style, tokens } = pushPull(
      {
        display: "flex",
        "flex-direction": "column",
        "row-gap": "16px",
        "background-color": "rgb(255, 255, 255)",
        "border-top-width": "1px",
        "border-right-width": "1px",
        "border-bottom-width": "1px",
        "border-left-width": "1px",
        "border-top-style": "solid",
        "border-right-style": "solid",
        "border-bottom-style": "solid",
        "border-left-style": "solid",
        "border-top-color": "rgb(229, 229, 229)",
        "border-top-left-radius": "12px",
        "border-top-right-radius": "12px",
        "border-bottom-right-radius": "12px",
        "border-bottom-left-radius": "12px",
      },
      {
        fillToken: "color/card",
        strokeToken: "color/border",
        radiusToken: "radius/xl",
        gapToken: "space/4",
      },
    );
    expect(tokens).toEqual({
      background: "color/card",
      "border-color": "color/border",
      "border-radius": "radius/xl",
      gap: "space/4",
    });
    for (const prop of ["background", "border-color", "border-radius", "gap"]) {
      expect(style[prop]).toBeUndefined();
    }
    // Non-bindable stroke facets stay literal.
    expect(style["border-width"]).toBe("1px");
    expect(style["border-style"]).toBe("solid");
  });

  it("radius-scale token binds border-radius with no raw px anywhere", () => {
    // Bug 2 regression: `rounded-xl` (14px = calc(var(--radius) * 1.4)) is
    // attributed to the derived px variable `radius-xl`; render.ts binds all
    // four corner fields to it (applyFrameVisuals L380-387) and the pull
    // reads the binding back by NAME so Pi can map it to `rounded-xl` —
    // never a hardcoded `rounded-[14px]`.
    const { style, tokens } = pushPull(
      {
        "border-top-left-radius": "14px",
        "border-top-right-radius": "14px",
        "border-bottom-right-radius": "14px",
        "border-bottom-left-radius": "14px",
      },
      { radiusToken: "radius-xl" },
    );
    expect(tokens["border-radius"]).toBe("radius-xl");
    expect(style["border-radius"]).toBeUndefined();

    const html = htmlNodeToString({ style, tokens });
    expect(html).toContain('data-token-border-radius="radius-xl"');
    expect(html).not.toContain("14px");
  });

  it("designer-bound padding aliases read back per side (no push source)", () => {
    const snap = simulateFrameNode({
      layout: flexToLayout(
        {
          display: "flex",
          "flex-direction": "row",
          "padding-top": "8px",
          "padding-right": "12px",
          "padding-bottom": "8px",
          "padding-left": "12px",
        },
        RECT,
        RECT,
      ),
    });
    snap.boundTokens = { paddingTop: "space/2", paddingBottom: "space/2" };
    const { style, tokens } = figmaNodeToCss(snap);
    expect(tokens["padding-top"]).toBe("space/2");
    expect(tokens["padding-bottom"]).toBe("space/2");
    expect(style["padding-right"]).toBe("12px");
    expect(style["padding-left"]).toBe("12px");
    expect(style.padding).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Absolute positioning (Bug 3: pull used to drop it entirely)
// ---------------------------------------------------------------------------

describe("figmaNodeToCss — absolute positioning", () => {
  it("child of a none-layout parent round-trips position/left/top", () => {
    // Push: a CSS-absolute badge (`absolute top-2 left-2`) inside a relative
    // wrapper serializes under a mode-"none" parent; render.ts appendChildren
    // (L466-468) writes node.x/y. Pull: x/y + NONE parent → absolute.
    const { style } = pushPull(
      { display: "flex", "flex-direction": "row" },
      {
        rect: { x: 8, y: 8, width: 57, height: 22 },
        parentRect: { x: 0, y: 0, width: 288, height: 192 },
        parent: { mode: "none" },
      },
    );
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("8px");
    expect(style.top).toBe("8px");
    expect(style.width).toBe("57px");
    expect(style.height).toBe("22px");
  });

  it("parent of absolute children emits position: relative", () => {
    const { style } = pushPull(
      { display: "block" },
      { children: [{}, {}] }, // mode "none" + children → free positioning
    );
    expect(style.position).toBe("relative");
  });

  it("an absolute node with absolute children stays absolute (already a containing block)", () => {
    const { style } = pushPull(
      { display: "block" },
      {
        rect: { x: 4, y: 6, width: 40, height: 20 },
        parentRect: { x: 0, y: 0, width: 240, height: 120 },
        parent: { mode: "none" },
        children: [{}],
      },
    );
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("4px");
    expect(style.top).toBe("6px");
  });

  it("designer-set layoutPositioning ABSOLUTE inside autolayout reads back absolute", () => {
    // No push source (push never writes layoutPositioning) — designer-only.
    const snap = simulateFrameNode({
      layout: flexToLayout({ display: "block" }, { x: 12, y: 16, width: 40, height: 20 }, RECT),
      parent: { mode: "vertical", counterAlign: "stretch" },
    });
    snap.layoutPositioning = "ABSOLUTE";
    snap.x = 12;
    snap.y = 16;
    const { style } = figmaNodeToCss(snap, {
      layoutMode: "VERTICAL",
      stretchChildren: true,
    });
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("12px");
    expect(style.top).toBe("16px");
    // Out of the autolayout flow: no fill semantics, size stays FIXED px.
    expect(style["flex-grow"]).toBeUndefined();
    expect(style["align-self"]).toBeUndefined();
    expect(style.width).toBe("40px");
    expect(style.height).toBe("20px");
  });

  it("CSS-absolute child of a FLEX parent round-trips via layoutPositioning ABSOLUTE", () => {
    // Push: flexToLayout marks `position: absolute` (layout.absolute) and
    // render.ts appendChildren opts the node out of the autolayout flow
    // (layoutPositioning ABSOLUTE + x/y) instead of flowing it.
    const { style } = pushPull(
      { display: "flex", "flex-direction": "row", position: "absolute" },
      {
        rect: { x: 8, y: 8, width: 57, height: 22 },
        parentRect: { x: 0, y: 0, width: 288, height: 160 },
        parent: { mode: "vertical", counterAlign: "stretch" },
      },
    );
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("8px");
    expect(style.top).toBe("8px");
    expect(style["align-self"]).toBeUndefined();
    expect(style["flex-grow"]).toBeUndefined();
    expect(style.width).toBe("57px");
    expect(style.height).toBe("22px");
  });

  it("absolute INSTANCE child keeps position on its data-component node (Bug A)", () => {
    // Replica of readHtml.ts's instance branch: a MINIMAL snapshot (size +
    // x/y + layoutPositioning only — no fills/text/layout, no recursion), so
    // an absolutely-positioned nested component (ProductBadges) keeps its
    // placement while its internals stay the component's own business.
    const snap: FigmaNodeSnapshot = { width: 57, height: 22, x: 8, y: 8 };
    const { style, tokens } = figmaNodeToCss(snap, { layoutMode: "NONE" });
    expect(tokens).toEqual({});
    expect(style).toEqual({
      position: "absolute",
      left: "8px",
      top: "8px",
      width: "57px",
      height: "22px",
    });
    const html = htmlNodeToString({ component: "product.ProductBadges", style });
    expect(html).toContain('data-component="product.ProductBadges"');
    expect(html).toContain("position: absolute");

    // The same instance with designer/push-set layoutPositioning ABSOLUTE
    // inside an autolayout parent.
    const autolayoutSnap: FigmaNodeSnapshot = {
      width: 57,
      height: 22,
      x: 8,
      y: 8,
      layoutPositioning: "ABSOLUTE",
    };
    const auto = figmaNodeToCss(autolayoutSnap, {
      layoutMode: "VERTICAL",
      stretchChildren: true,
    });
    expect(auto.style.position).toBe("absolute");
    expect(auto.style.left).toBe("8px");
    expect(auto.style.top).toBe("8px");

    // An IN-FLOW instance keeps emitting no style at all (readHtml only maps
    // the snapshot when the instance is absolute).
  });

  it("absolute text child keeps left/top (badge label in a none wrapper)", () => {
    const { style } = figmaNodeToCss(
      simulateTextNode({
        text: {
          characters: "Sale",
          font: { family: "Inter", weight: 600, italic: false, size: 12 },
          color: { r: 1, g: 1, b: 1, a: 1 },
          align: "left",
          autoWidth: true,
        },
        layout: { width: 30, height: 16, x: 8, y: 3 },
        parent: { mode: "none" },
      }),
      { layoutMode: "NONE" },
    );
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("8px");
    expect(style.top).toBe("3px");
  });

  it("the pulled ROOT never goes absolute (no parent context)", () => {
    const { style } = pushPull({ display: "block" });
    expect(style.position).toBeUndefined();
    expect(style.left).toBeUndefined();
    expect(style.top).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Text round-trips
// ---------------------------------------------------------------------------

describe("figmaNodeToCss — text round-trip", () => {
  const baseFont = {
    family: "Inter",
    weight: 400,
    italic: false,
    size: 14,
  };
  const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };

  it("full text style: family, weight, size, line-height, spacing, align", () => {
    const { style, tokens } = figmaNodeToCss(
      simulateTextNode({
        text: {
          characters: "Add to cart",
          font: { ...baseFont, weight: 600, lineHeightPx: 20, letterSpacing: 0.5 },
          color: parseCssColor("rgb(23, 23, 23)")!,
          align: "center",
          autoWidth: true,
        },
        layout: { width: 80, height: 20 },
      }),
    );
    expect(tokens).toEqual({});
    expect(style).toEqual({
      color: "#171717",
      "font-family": "Inter",
      "font-weight": "600",
      "font-size": "14px",
      "line-height": "20px",
      "letter-spacing": "0.5px",
      "text-align": "center",
      // autoWidth (textAutoResize WIDTH_AND_HEIGHT) hugs both axes: no size.
    });
  });

  it("regular weight / left align / zero spacing stay implicit", () => {
    const { style } = figmaNodeToCss(
      simulateTextNode({
        text: {
          characters: "x",
          font: { ...baseFont, letterSpacing: 0 },
          color: black,
          align: "left",
          autoWidth: true,
        },
        layout: { width: 10, height: 17 },
      }),
    );
    expect(style["font-weight"]).toBeUndefined();
    expect(style["text-align"]).toBeUndefined();
    expect(style["letter-spacing"]).toBeUndefined();
    expect(style["font-style"]).toBeUndefined();
  });

  it("bold italic round-trips through the Figma style name", () => {
    const { style } = figmaNodeToCss(
      simulateTextNode({
        text: {
          characters: "x",
          font: { ...baseFont, weight: 700, italic: true },
          color: black,
          align: "left",
          autoWidth: true,
        },
        layout: { width: 10, height: 17 },
      }),
    );
    expect(style["font-weight"]).toBe("700");
    expect(style["font-style"]).toBe("italic");
  });

  it("multi-line text in a none parent keeps its fixed wrapping width", () => {
    const { style } = figmaNodeToCss(
      simulateTextNode({
        text: {
          characters: "long wrapped copy",
          font: baseFont,
          color: black,
          align: "left",
        },
        layout: { width: 200, height: 40 },
        parent: { mode: "none" },
      }),
      { layoutMode: "NONE" },
    );
    expect(style.width).toBe("200px");
    expect(style.height).toBeUndefined(); // textAutoResize HEIGHT hugs height
  });

  it("fillWidth text stretches across a vertical parent / grows in a horizontal one", () => {
    const vertical = figmaNodeToCss(
      simulateTextNode({
        text: { characters: "x", font: baseFont, color: black, align: "left", fillWidth: true },
        layout: { width: 200, height: 40 },
        parent: { mode: "vertical", counterAlign: "min" },
      }),
      { layoutMode: "VERTICAL", stretchChildren: false },
    );
    expect(vertical.style["align-self"]).toBe("stretch");
    expect(vertical.style.width).toBeUndefined();

    const horizontal = figmaNodeToCss(
      simulateTextNode({
        text: { characters: "x", font: baseFont, color: black, align: "left", fillWidth: true },
        layout: { width: 200, height: 40 },
        parent: { mode: "horizontal", counterAlign: "min" },
      }),
      { layoutMode: "HORIZONTAL", stretchChildren: false },
    );
    expect(horizontal.style["flex-grow"]).toBe("1");
    expect(horizontal.style.width).toBeUndefined();
  });

  it("text color token binds as tokens.color, not style", () => {
    const { style, tokens } = figmaNodeToCss(
      simulateTextNode({
        text: {
          characters: "x",
          font: baseFont,
          color: black,
          colorToken: "color/primary",
          align: "left",
          autoWidth: true,
        },
        layout: { width: 10, height: 17 },
      }),
    );
    expect(tokens.color).toBe("color/primary");
    expect(style.color).toBeUndefined();
  });

  it("designer-only text fields read back (no push source)", () => {
    const snap = simulateTextNode({
      text: { characters: "x", font: baseFont, color: black, align: "left", autoWidth: true },
      layout: { width: 10, height: 17 },
    });
    snap.textDecoration = "UNDERLINE";
    snap.textCase = "UPPER";
    snap.lineHeightPercent = 150;
    snap.letterSpacingPercent = 5;
    const { style } = figmaNodeToCss(snap);
    expect(style["text-decoration"]).toBe("underline");
    expect(style["text-transform"]).toBe("uppercase");
    expect(style["line-height"]).toBe("150%");
    expect(style["letter-spacing"]).toBe("0.05em");

    snap.textDecoration = "STRIKETHROUGH";
    snap.textCase = "TITLE";
    const strike = figmaNodeToCss(snap).style;
    expect(strike["text-decoration"]).toBe("line-through");
    expect(strike["text-transform"]).toBe("capitalize");
  });
});

// ---------------------------------------------------------------------------
// Stretch-default helper
// ---------------------------------------------------------------------------

describe("isStretchDefault", () => {
  it("is true only for MIN counter axis with every child STRETCH", () => {
    const base: FigmaNodeSnapshot = {
      layoutMode: "VERTICAL",
      counterAxisAlignItems: "MIN",
      childLayoutAligns: ["STRETCH", "STRETCH"],
    };
    expect(isStretchDefault(base)).toBe(true);
    expect(isStretchDefault({ ...base, counterAxisAlignItems: "CENTER" })).toBe(false);
    expect(isStretchDefault({ ...base, childLayoutAligns: ["STRETCH", "INHERIT"] })).toBe(false);
    expect(isStretchDefault({ ...base, childLayoutAligns: [] })).toBe(false);
    expect(isStretchDefault({ ...base, layoutMode: "NONE" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProductCard regression (the dogfood repro: push → pull with no Figma edits)
// ---------------------------------------------------------------------------

describe("ProductCard regression — nothing the push wrote is dropped", () => {
  it("root card frame keeps sizing, border, shadow, autolayout, and tokens", () => {
    // The demo ProductCard root (examples/demo …product/variants/Card.tsx):
    // w-80 (320px) vertical flex, gap-4 (16px), p-4 (16px), rounded-xl border
    // bg-card shadow-sm — with background/border-color bound to theme tokens.
    const css: StyleRecord = {
      display: "flex",
      "flex-direction": "column",
      "row-gap": "16px",
      "padding-top": "16px",
      "padding-right": "16px",
      "padding-bottom": "16px",
      "padding-left": "16px",
      "background-color": "rgb(255, 255, 255)",
      "border-top-width": "1px",
      "border-right-width": "1px",
      "border-bottom-width": "1px",
      "border-left-width": "1px",
      "border-top-style": "solid",
      "border-right-style": "solid",
      "border-bottom-style": "solid",
      "border-left-style": "solid",
      "border-top-color": "rgb(229, 229, 229)",
      "border-top-left-radius": "12px",
      "border-top-right-radius": "12px",
      "border-bottom-right-radius": "12px",
      "border-bottom-left-radius": "12px",
      "box-shadow": "rgba(0, 0, 0, 0.05) 0px 1px 2px 0px",
      "align-items": "normal",
    };
    const { style, tokens } = pushPull(css, {
      rect: { x: 0, y: 0, width: 320, height: 420 },
      fillToken: "color/card",
      strokeToken: "color/border",
      children: [{}, {}, {}, {}], // image wrapper, header, content, footer
      // The card has no authored height (w-80 gap-4 p-4): the serializer
      // measures `height: auto` as a no-op and pushes HUG (Bug B) — so the
      // pull must NOT echo a fixed 420px for Pi to hardcode.
      hugHeight: true,
    });

    expect(tokens).toEqual({
      background: "color/card",
      "border-color": "color/border",
    });
    expect(style).toEqual({
      display: "flex",
      "flex-direction": "column",
      gap: "16px",
      padding: "16px",
      "border-width": "1px",
      "border-style": "solid",
      "border-radius": "12px",
      "box-shadow": "0px 1px 2px 0px rgba(0, 0, 0, 0.05)",
      width: "320px", // w-80 IS authored — stays fixed
      // height omitted: content-determined (hugHeight).
      // align-items stretch stays implicit (CSS default).
    });

    // The exact properties the dogfood round-trip dropped:
    for (const prop of ["width", "border-width", "border-style", "box-shadow"]) {
      expect(style[prop], `regression: ${prop} must not be dropped`).toBeDefined();
    }
  });

  it("image+badges wrapper (block-stack upgrade): no fixed height, badge instance absolute", () => {
    // Original code: `<div class="relative">` (NO authored height) with an
    // in-flow full-width image (h-40) and an absolute ProductBadges
    // INSTANCE. The serializer upgrades the block wrapper to a VERTICAL
    // autolayout (upgradeBlockStack / blockStackGap: single full-width
    // in-flow child) and measures its height as content-determined
    // (hugHeight) — so the pull emits NO height (the h-40 the wrapper
    // spuriously gained in the dogfood retest) and the badge keeps its
    // absolute placement (Bug A + Bug B).
    const wrapperRect = { x: 0, y: 0, width: 288, height: 160 };
    const wrapperLayout = flexToLayout({ display: "block" }, wrapperRect, wrapperRect);
    // upgradeBlockStack result for [image at 0,0 288x160]:
    wrapperLayout.mode = "vertical";
    wrapperLayout.primaryAlign = "min";
    wrapperLayout.counterAlign = "stretch";
    // isContentHeight: no authored height -> hug.
    wrapperLayout.hugHeight = true;
    const wrapper = figmaNodeToCss(
      simulateFrameNode({
        layout: wrapperLayout,
        parent: { mode: "vertical", counterAlign: "stretch" },
        children: [{}, { absolute: true }], // image in flow, badge absolute
      }),
      { layoutMode: "VERTICAL", stretchChildren: true },
    );
    expect(wrapper.style.position).toBe("relative"); // anchors the badge
    expect(wrapper.style.height).toBeUndefined(); // NO h-40 noise
    expect(wrapper.style.width).toBeUndefined(); // stretch child of the card
    expect(wrapper.style.display).toBe("flex");
    expect(wrapper.style["flex-direction"]).toBe("column");
    // The absolute badge is excluded from the stretch-default probe.
    expect(wrapper.style["align-items"]).toBeUndefined();

    // The image keeps its AUTHORED h-40 (isContentHeight false -> FIXED).
    const image = pushPull(
      { display: "block" },
      {
        rect: { x: 0, y: 0, width: 288, height: 160 },
        parent: { mode: "vertical", counterAlign: "stretch" },
      },
    );
    expect(image.style.height).toBe("160px");
    expect(image.style.width).toBeUndefined(); // stretch width
    expect(image.style.position).toBeUndefined(); // in flow

    // The badge INSTANCE: minimal snapshot (readHtml.ts replica) with the
    // layoutPositioning ABSOLUTE the push now writes for CSS-absolute
    // children of autolayout parents.
    const badge = figmaNodeToCss(
      { width: 57, height: 22, x: 8, y: 8, layoutPositioning: "ABSOLUTE" },
      { layoutMode: "VERTICAL", stretchChildren: true },
    );
    expect(badge.style).toEqual({
      position: "absolute",
      left: "8px",
      top: "8px",
      width: "57px",
      height: "22px",
    });
    const html = htmlNodeToString({
      component: "product.ProductBadges",
      style: badge.style,
    });
    expect(html).toContain('data-component="product.ProductBadges"');
    expect(html).toContain("position: absolute");
  });

  it("non-stack wrapper (residual mode none): children keep free positions", () => {
    // When the in-flow children do NOT form a clean stack (overlap, uneven
    // gaps, narrow children) the container stays mode "none" — Figma NONE
    // frames need FIXED sizes, so width/height stay literal and children
    // read back absolute (documented residual case).
    const wrapperRect = { x: 0, y: 0, width: 288, height: 192 };
    const wrapper = pushPull(
      { display: "block", overflow: "hidden" },
      {
        rect: wrapperRect,
        parent: { mode: "vertical", counterAlign: "stretch" },
        children: [{}, {}],
      },
    );
    expect(wrapper.style.position).toBe("relative");
    expect(wrapper.style.height).toBe("192px"); // NONE frames stay FIXED

    const badge = pushPull(
      { display: "flex", "flex-direction": "row" },
      {
        rect: { x: 8, y: 8, width: 57, height: 22 },
        parentRect: wrapperRect,
        parent: { mode: "none" },
      },
    );
    expect(badge.style.position).toBe("absolute");
    expect(badge.style.left).toBe("8px");
    expect(badge.style.top).toBe("8px");
  });

  it("footer row keeps space-between + centered alignment", () => {
    const { style } = pushPull(
      {
        display: "flex",
        "flex-direction": "row",
        "justify-content": "space-between",
        "align-items": "center",
      },
      {
        rect: { x: 0, y: 0, width: 288, height: 36 },
        parent: { mode: "vertical", counterAlign: "stretch" },
        children: [{}, {}],
      },
    );
    expect(style["justify-content"]).toBe("space-between");
    expect(style["align-items"]).toBe("center");
    // FILL width via the parent's stretch default: implicit, not fixed.
    expect(style.width).toBeUndefined();
    expect(style["align-self"]).toBeUndefined();
    expect(style.height).toBe("36px");
  });
});
