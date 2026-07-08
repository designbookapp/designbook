import { describe, expect, it } from "vitest";
import {
  blockStackGap,
  cssWeightToFigmaStyle,
  formatRootMarker,
  parseRootMarker,
  ROOT_MARKER_VERSION,
  decideTextSizing,
  flexToLayout,
  hashRenderTree,
  parseBoxShadow,
  parseLinearGradient,
  styleToVisuals,
  type RenderTree,
} from "./figmaRender";

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

describe("flexToLayout", () => {
  it("maps display:flex row with gap, padding, and alignment", () => {
    const layout = flexToLayout(
      {
        display: "flex",
        "flex-direction": "row",
        "column-gap": "16px",
        "row-gap": "8px",
        "justify-content": "space-between",
        "align-items": "center",
        "padding-top": "4px",
        "padding-right": "8px",
        "padding-bottom": "4px",
        "padding-left": "8px",
      },
      rect(110, 220, 300, 40),
      rect(100, 200, 400, 100),
    );
    expect(layout).toEqual({
      mode: "horizontal",
      x: 10,
      y: 20,
      width: 300,
      height: 40,
      gap: 16,
      counterGap: 8,
      primaryAlign: "space-between",
      counterAlign: "center",
      padding: [4, 8, 4, 8],
    });
  });

  it("maps column direction, wrap, stretch, and reverse", () => {
    const layout = flexToLayout(
      {
        display: "inline-flex",
        "flex-direction": "column-reverse",
        "row-gap": "12px",
        "flex-wrap": "wrap",
        "justify-content": "flex-end",
        "align-items": "stretch",
      },
      rect(0, 0, 100, 200),
      rect(0, 0, 100, 200),
    );
    expect(layout.mode).toBe("vertical");
    expect(layout.reverse).toBe(true);
    expect(layout.gap).toBe(12);
    expect(layout.wrap).toBe(true);
    expect(layout.primaryAlign).toBe("max");
    expect(layout.counterAlign).toBe("stretch");
  });

  it("maps space-around/evenly to space-between", () => {
    for (const value of ["space-around", "space-evenly"]) {
      const layout = flexToLayout(
        { display: "flex", "justify-content": value },
        rect(0, 0, 10, 10),
        rect(0, 0, 10, 10),
      );
      expect(layout.primaryAlign).toBe("space-between");
    }
  });

  it("maps non-flex display to mode none with measured offsets", () => {
    const layout = flexToLayout(
      { display: "block" },
      rect(30, 45, 50, 20),
      rect(10, 5, 200, 200),
    );
    expect(layout).toEqual({
      mode: "none",
      x: 20,
      y: 40,
      width: 50,
      height: 20,
    });
  });

  it("marks flex-grow > 0 children as grow", () => {
    const layout = flexToLayout(
      { display: "block", "flex-grow": "1" },
      rect(0, 0, 10, 10),
      rect(0, 0, 10, 10),
    );
    expect(layout.grow).toBe(true);
  });
});

describe("flexToLayout — position", () => {
  it("marks absolute/fixed elements and leaves others in flow", () => {
    const abs = flexToLayout({ position: "absolute" }, rect(8, 8, 57, 22), rect(0, 0, 288, 192));
    expect(abs.absolute).toBe(true);
    expect(abs.x).toBe(8);
    expect(abs.y).toBe(8);
    expect(flexToLayout({ position: "fixed" }, rect(0, 0, 10, 10), rect(0, 0, 10, 10)).absolute).toBe(true);
    for (const position of ["static", "relative", "sticky", ""]) {
      expect(
        flexToLayout({ position }, rect(0, 0, 10, 10), rect(0, 0, 10, 10)).absolute,
      ).toBeUndefined();
    }
  });
});

describe("blockStackGap", () => {
  const container = rect(0, 0, 288, 192);

  it("accepts a single full-width child at the origin (the image wrapper)", () => {
    expect(blockStackGap([rect(0, 0, 288, 160)], undefined, container)).toEqual({
      gap: 0,
    });
  });

  it("accepts a uniform-gap stack and reports the gap", () => {
    expect(
      blockStackGap(
        [rect(0, 0, 288, 60), rect(0, 68, 288, 60), rect(0, 136, 288, 40)],
        undefined,
        container,
      ),
    ).toEqual({ gap: 8 });
  });

  it("respects the container padding as the stack origin", () => {
    expect(
      blockStackGap(
        [rect(16, 12, 256, 100)],
        [12, 16, 12, 16],
        container,
      ),
    ).toEqual({ gap: 0 });
  });

  it("rejects narrow, offset, uneven, overlapping, and empty shapes", () => {
    // Narrow child (not full width).
    expect(blockStackGap([rect(0, 0, 120, 60)], undefined, container)).toBeNull();
    // Offset from the origin.
    expect(blockStackGap([rect(0, 24, 288, 60)], undefined, container)).toBeNull();
    // Uneven gaps.
    expect(
      blockStackGap(
        [rect(0, 0, 288, 60), rect(0, 64, 288, 60), rect(0, 140, 288, 40)],
        undefined,
        container,
      ),
    ).toBeNull();
    // Overlap.
    expect(
      blockStackGap(
        [rect(0, 0, 288, 60), rect(0, 40, 288, 60)],
        undefined,
        container,
      ),
    ).toBeNull();
    // Nothing in flow (only absolute children) — stays mode none.
    expect(blockStackGap([], undefined, container)).toBeNull();
  });
});

describe("parseBoxShadow", () => {
  it("parses a computed-style shadow (color first)", () => {
    const effects = parseBoxShadow("rgba(0, 0, 0, 0.1) 0px 4px 6px -1px");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toEqual({
      kind: "drop-shadow",
      x: 0,
      y: 4,
      blur: 6,
      spread: -1,
      color: { r: 0, g: 0, b: 0, a: 0.1 },
    });
  });

  it("parses multiple shadows and inset", () => {
    const effects = parseBoxShadow(
      "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px, rgb(255, 0, 0) 0px 0px 4px 2px inset",
    );
    expect(effects).toHaveLength(2);
    expect(effects[0].kind).toBe("drop-shadow");
    expect(effects[1].kind).toBe("inner-shadow");
    expect(effects[1].color).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(effects[1].spread).toBe(2);
  });

  it("returns [] for none/empty", () => {
    expect(parseBoxShadow("none")).toEqual([]);
    expect(parseBoxShadow("")).toEqual([]);
  });
});

describe("parseLinearGradient", () => {
  it("parses angle + stops with positions", () => {
    const paint = parseLinearGradient(
      "linear-gradient(45deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)",
    );
    expect(paint).not.toBeNull();
    if (paint?.kind !== "gradient") throw new Error("expected gradient");
    expect(paint.angle).toBe(45);
    expect(paint.stops).toEqual([
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
    ]);
  });

  it("defaults angle to 180 and interpolates missing positions", () => {
    const paint = parseLinearGradient(
      "linear-gradient(rgb(255, 255, 255), rgb(128, 128, 128), rgb(0, 0, 0))",
    );
    if (paint?.kind !== "gradient") throw new Error("expected gradient");
    expect(paint.angle).toBe(180);
    expect(paint.stops.map((stop) => stop.position)).toEqual([0, 0.5, 1]);
  });

  it("maps `to` keywords and rejects non-gradients", () => {
    const paint = parseLinearGradient(
      "linear-gradient(to right, #000, #fff)",
    );
    if (paint?.kind !== "gradient") throw new Error("expected gradient");
    expect(paint.angle).toBe(90);
    expect(parseLinearGradient("radial-gradient(red, blue)")).toBeNull();
    expect(parseLinearGradient("url(foo.png)")).toBeNull();
  });
});

describe("styleToVisuals", () => {
  it("maps background color, uniform border, radius, and overflow", () => {
    const visuals = styleToVisuals({
      "background-color": "rgb(255, 255, 255)",
      "border-top-width": "1px",
      "border-right-width": "1px",
      "border-bottom-width": "1px",
      "border-left-width": "1px",
      "border-top-style": "solid",
      "border-right-style": "solid",
      "border-bottom-style": "solid",
      "border-left-style": "solid",
      "border-top-color": "rgb(0, 0, 0)",
      "border-top-left-radius": "8px",
      "border-top-right-radius": "8px",
      "border-bottom-right-radius": "8px",
      "border-bottom-left-radius": "8px",
      overflow: "hidden",
    });
    expect(visuals.fills).toEqual([
      { kind: "solid", color: { r: 1, g: 1, b: 1, a: 1 } },
    ]);
    expect(visuals.stroke).toEqual({
      color: { r: 0, g: 0, b: 0, a: 1 },
      weight: 1,
    });
    expect(visuals.cornerRadius).toBe(8);
    expect(visuals.clipsContent).toBe(true);
  });

  it("keeps per-corner radii and skips transparent backgrounds", () => {
    const visuals = styleToVisuals({
      "background-color": "rgba(0, 0, 0, 0)",
      "border-top-left-radius": "8px",
      "border-top-right-radius": "8px",
      "border-bottom-right-radius": "0px",
      "border-bottom-left-radius": "0px",
    });
    expect(visuals.fills).toBeUndefined();
    expect(visuals.cornerRadius).toEqual([8, 8, 0, 0]);
  });

  it("skips non-uniform borders and layers gradient over color", () => {
    const visuals = styleToVisuals({
      "background-color": "rgb(10, 10, 10)",
      "background-image": "linear-gradient(90deg, rgb(0,0,0) 0%, rgb(9,9,9) 100%)",
      "border-top-width": "2px",
      "border-right-width": "0px",
      "border-bottom-width": "0px",
      "border-left-width": "0px",
      "border-top-style": "solid",
      "border-top-color": "rgb(0, 0, 0)",
    });
    expect(visuals.stroke).toBeUndefined();
    expect(visuals.fills).toHaveLength(2);
    expect(visuals.fills?.[0].kind).toBe("solid");
    expect(visuals.fills?.[1].kind).toBe("gradient");
  });

  it("maps opacity < 1", () => {
    expect(styleToVisuals({ opacity: "0.5" }).opacity).toBe(0.5);
    expect(styleToVisuals({ opacity: "1" }).opacity).toBeUndefined();
  });
});

describe("decideTextSizing", () => {
  it("flags single-line text (height ≤ 1.5× line height) as autoWidth", () => {
    // "New": rect 15.5 tall, line-height 16.
    expect(decideTextSizing(15.5, 12, 16, "horizontal")).toEqual({
      autoWidth: true,
      fillWidth: false,
    });
    expect(decideTextSizing(20.5, 16, 20, "none")).toEqual({
      autoWidth: true,
      fillWidth: false,
    });
  });

  it("flags multi-line text in an autolayout parent as fillWidth", () => {
    // Two 20px lines.
    expect(decideTextSizing(38, 14, 20, "vertical")).toEqual({
      autoWidth: false,
      fillWidth: true,
    });
    expect(decideTextSizing(38, 14, 20, "horizontal")).toEqual({
      autoWidth: false,
      fillWidth: true,
    });
  });

  it("keeps multi-line text in a mode:none parent fixed (neither flag)", () => {
    expect(decideTextSizing(38, 14, 20, "none")).toEqual({
      autoWidth: false,
      fillWidth: false,
    });
  });

  it("falls back to 1.2×font-size when line-height is normal/unknown", () => {
    // 16px font → line 19.2, threshold 28.8.
    expect(decideTextSizing(19, 16, undefined, "none").autoWidth).toBe(true);
    expect(decideTextSizing(38, 16, undefined, "none").autoWidth).toBe(false);
    expect(decideTextSizing(19, 16, 0, "none").autoWidth).toBe(true);
  });
});

describe("cssWeightToFigmaStyle", () => {
  it("maps the standard buckets", () => {
    expect(cssWeightToFigmaStyle(400, false)[0]).toBe("Regular");
    expect(cssWeightToFigmaStyle(500, false)).toEqual(["Medium"]);
    expect(cssWeightToFigmaStyle(600, false).slice(0, 2)).toEqual([
      "SemiBold",
      "Semi Bold",
    ]);
    expect(cssWeightToFigmaStyle(700, false)).toEqual(["Bold"]);
  });

  it("snaps odd weights to the nearest bucket", () => {
    expect(cssWeightToFigmaStyle(450, false)[0]).toBe("Regular");
    expect(cssWeightToFigmaStyle(650, false)[0]).toBe("SemiBold");
  });

  it("produces italic variants", () => {
    expect(cssWeightToFigmaStyle(400, true)[0]).toBe("Italic");
    expect(cssWeightToFigmaStyle(700, true)).toEqual(["Bold Italic"]);
  });
});

describe("hashRenderTree", () => {
  function makeTree(): RenderTree {
    return {
      componentId: "search.ResultsList",
      componentName: "ResultsList",
      images: {},
      root: {
        dbId: "r",
        type: "frame",
        name: "ResultsList",
        layout: { mode: "vertical", x: 0, y: 0, width: 400, height: 300 },
        children: [
          {
            dbId: "r.0",
            type: "text",
            name: "Results",
            layout: { mode: "none", x: 0, y: 0, width: 100, height: 20 },
            text: {
              characters: "Results",
              font: { family: "Inter", weight: 600, italic: false, size: 20 },
              color: { r: 0, g: 0, b: 0, a: 1 },
              align: "left",
            },
          },
        ],
      },
      childComponents: {},
      meta: {
        locale: "en-US",
        variant: "default",
        mode: "light",
        pushedAt: "2026-01-01T00:00:00.000Z",
        hash: "",
      },
    };
  }

  it("is stable across pushes (ignores pushedAt/hash)", () => {
    const a = makeTree();
    const b = makeTree();
    b.meta.pushedAt = "2026-02-02T12:00:00.000Z";
    b.meta.hash = "deadbeef";
    expect(hashRenderTree(a)).toBe(hashRenderTree(b));
  });

  it("changes when content changes", () => {
    const a = makeTree();
    const b = makeTree();
    b.root.children![0].text!.characters = "Résultats";
    expect(hashRenderTree(a)).not.toBe(hashRenderTree(b));
    const c = makeTree();
    c.meta.mode = "dark";
    expect(hashRenderTree(a)).not.toBe(hashRenderTree(c));
  });

  it("is insensitive to object key order", () => {
    const a = makeTree();
    const b = makeTree();
    b.root.layout = {
      height: 300,
      width: 400,
      y: 0,
      x: 0,
      mode: "vertical",
    };
    expect(hashRenderTree(a)).toBe(hashRenderTree(b));
  });
});

describe("root marker (formatRootMarker / parseRootMarker)", () => {
  it("round-trips the render context", () => {
    const raw = formatRootMarker({
      component: "product.ProductCard",
      v: ROOT_MARKER_VERSION,
      render: {
        locale: "en-US",
        theme: "default",
        mode: "light",
        dimensions: { "flags:tenant": "acme" },
      },
    });
    expect(parseRootMarker(raw)).toEqual({
      component: "product.ProductCard",
      v: 1,
      render: {
        locale: "en-US",
        theme: "default",
        mode: "light",
        dimensions: { "flags:tenant": "acme" },
      },
    });
  });

  it("drops empty render objects on write and read", () => {
    const raw = formatRootMarker({ component: "x.Y", v: 1, render: {} });
    expect(raw).toBe(JSON.stringify({ component: "x.Y", v: 1 }));
    expect(parseRootMarker(raw)).toEqual({ component: "x.Y", v: 1 });
  });

  it("tolerates pre-context v1 markers (additive field, no version bump)", () => {
    expect(
      parseRootMarker(JSON.stringify({ component: "product.ProductCard", v: 1 })),
    ).toEqual({ component: "product.ProductCard", v: 1 });
  });

  it("rejects malformed payloads instead of throwing", () => {
    for (const raw of ["", "not json", "42", "{}", JSON.stringify({ v: 1 })]) {
      expect(parseRootMarker(raw)).toBeUndefined();
    }
    // Non-string dimension values are dropped, valid ones kept.
    const mixed = parseRootMarker(
      JSON.stringify({
        component: "x.Y",
        v: 1,
        render: { locale: "en-US", dimensions: { good: "yes", bad: 3 } },
      }),
    );
    expect(mixed).toEqual({
      component: "x.Y",
      v: 1,
      render: { locale: "en-US", dimensions: { good: "yes" } },
    });
  });
});
