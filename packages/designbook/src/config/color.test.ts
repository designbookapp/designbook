import { describe, expect, it } from "vitest";
import {
  formatOklch,
  hexToRgb,
  oklchToHex,
  oklchToRgb,
  parseCssColor,
  parseOklch,
  rgbToHex,
  rgbToOklch,
} from "./color";

describe("parseOklch", () => {
  it("parses oklch(L C H)", () => {
    expect(parseOklch("oklch(0.5 0.19 258)")).toEqual({
      L: 0.5,
      C: 0.19,
      H: 258,
      a: 1,
    });
  });

  it("parses an alpha channel (0..1 and percent)", () => {
    expect(parseOklch("oklch(1 0 0 / 0.1)")).toEqual({
      L: 1,
      C: 0,
      H: 0,
      a: 0.1,
    });
    expect(parseOklch("oklch(1 0 0 / 10%)")).toEqual({
      L: 1,
      C: 0,
      H: 0,
      a: 0.1,
    });
  });

  it("parses a percentage lightness", () => {
    const parsed = parseOklch("oklch(50% 0.1 120)");
    expect(parsed?.L).toBeCloseTo(0.5, 10);
  });

  it("returns null for non-oklch strings", () => {
    expect(parseOklch("#fff")).toBeNull();
    expect(parseOklch("rgb(0 0 0)")).toBeNull();
    expect(parseOklch("oklch(0.5 0.1)")).toBeNull();
  });
});

describe("oklchToRgb known values", () => {
  it("maps white and black", () => {
    const white = oklchToRgb({ L: 1, C: 0, H: 0, a: 1 });
    expect(white.r).toBeCloseTo(1, 2);
    expect(white.g).toBeCloseTo(1, 2);
    expect(white.b).toBeCloseTo(1, 2);

    const black = oklchToRgb({ L: 0, C: 0, H: 0, a: 1 });
    expect(black.r).toBeCloseTo(0, 2);
    expect(black.g).toBeCloseTo(0, 2);
    expect(black.b).toBeCloseTo(0, 2);
  });

  it("preserves alpha", () => {
    expect(oklchToRgb({ L: 0.5, C: 0.1, H: 200, a: 0.42 }).a).toBe(0.42);
  });

  it("clamps out-of-gamut colors without producing NaN", () => {
    const rgb = oklchToRgb({ L: 0.9, C: 0.4, H: 30, a: 1 });
    for (const channel of [rgb.r, rgb.g, rgb.b]) {
      expect(Number.isNaN(channel)).toBe(false);
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });
});

describe("oklch round-trips", () => {
  it("round-trips the demo primary within tolerance", () => {
    const original = { L: 0.5, C: 0.19, H: 258, a: 1 };
    const back = rgbToOklch(oklchToRgb(original));
    expect(Math.abs(back.L - original.L)).toBeLessThan(0.01);
    expect(Math.abs(back.C - original.C)).toBeLessThan(0.01);
    expect(Math.abs(back.H - original.H)).toBeLessThan(1);
  });

  it("preserves alpha through a round-trip", () => {
    const back = rgbToOklch(oklchToRgb({ L: 0.6, C: 0.1, H: 145, a: 0.3 }));
    expect(back.a).toBeCloseTo(0.3, 10);
  });
});

describe("hex conversion", () => {
  it("round-trips hex ↔ rgb", () => {
    const rgb = hexToRgb("#3b82f6");
    expect(rgb).not.toBeNull();
    expect(rgbToHex(rgb!)).toBe("#3b82f6");
  });

  it("parses shorthand and alpha hex", () => {
    expect(hexToRgb("#fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    const withAlpha = hexToRgb("#00000080");
    expect(withAlpha?.a).toBeCloseTo(0.502, 2);
  });

  it("oklchToHex yields a valid 6-digit hex", () => {
    expect(oklchToHex({ L: 0, C: 0, H: 0, a: 1 })).toBe("#000000");
    expect(oklchToHex({ L: 1, C: 0, H: 0, a: 1 })).toBe("#ffffff");
  });
});

describe("formatOklch", () => {
  it("formats without alpha at sensible precision", () => {
    expect(formatOklch({ L: 0.50001, C: 0.19, H: 258.004, a: 1 })).toBe(
      "oklch(0.5 0.19 258)",
    );
  });

  it("appends alpha when below 1", () => {
    expect(formatOklch({ L: 1, C: 0, H: 0, a: 0.1 })).toBe(
      "oklch(1 0 0 / 0.1)",
    );
  });
});

describe("parseCssColor", () => {
  it("parses comma-syntax rgb()/rgba() (getComputedStyle output)", () => {
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    const withAlpha = parseCssColor("rgba(0, 0, 0, 0.5)");
    expect(withAlpha).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });

  it("parses modern space syntax with slash alpha", () => {
    expect(parseCssColor("rgb(0 128 255 / 0.25)")).toEqual({
      r: 0,
      g: 128 / 255,
      b: 1,
      a: 0.25,
    });
    expect(parseCssColor("rgb(100% 0% 50%)")).toEqual({
      r: 1,
      g: 0,
      b: 0.5,
      a: 1,
    });
  });

  it("parses transparent, hex, and oklch", () => {
    expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor("#ff0000")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    const oklchWhite = parseCssColor("oklch(1 0 0)");
    expect(oklchWhite?.r).toBeCloseTo(1, 2);
    expect(oklchWhite?.a).toBe(1);
  });

  it("returns null for non-colors", () => {
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("none")).toBeNull();
    expect(parseCssColor("var(--primary)")).toBeNull();
    expect(parseCssColor("linear-gradient(red, blue)")).toBeNull();
  });
});
