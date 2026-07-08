import { describe, expect, it } from "vitest";
import {
  evaluateCssDimension,
  inferTokenType,
  parseCssTokens,
  parseJsonTokens,
  parseRadiusScale,
  parseVariantOverrides,
  resolveTokenValue,
  resolveVariantModel,
} from "./themeTokens";
import type { ThemeTokenModel } from "./themeTokens";

const sampleCss = `@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-primary: var(--primary);
  --radius-lg: var(--radius);
}

:root {
  --primary: oklch(0.5 0.19 258);
  --background: oklch(1 0 0);
  --radius: 0.625rem;
  --font-scale: 1.2;
  --font-family: Inter;
}

.dark {
  --primary: oklch(0.68 0.16 258);
  --background: oklch(0.145 0 0);
}
`;

describe("inferTokenType", () => {
  it("classifies colors", () => {
    expect(inferTokenType("oklch(0.5 0.19 258)")).toBe("color");
    expect(inferTokenType("rgb(0 0 0)")).toBe("color");
    expect(inferTokenType("hsl(0 0% 0%)")).toBe("color");
    expect(inferTokenType("#ff0000")).toBe("color");
  });

  it("classifies dimensions", () => {
    expect(inferTokenType("0.625rem")).toBe("dimension");
    expect(inferTokenType("16px")).toBe("dimension");
    expect(inferTokenType("2em")).toBe("dimension");
    expect(inferTokenType("50%")).toBe("dimension");
  });

  it("classifies numbers and strings", () => {
    expect(inferTokenType("1.2")).toBe("number");
    expect(inferTokenType("-3")).toBe("number");
    expect(inferTokenType("Inter")).toBe("string");
  });
});

describe("parseCssTokens", () => {
  const model = parseCssTokens(sampleCss, { light: ":root", dark: ".dark" });

  it("reads the mode selector blocks and ignores the @theme block", () => {
    expect(model.modes).toEqual(["light", "dark"]);
    const names = model.tokens.map((token) => token.name);
    // @theme aliases (--color-primary, --radius-lg) must not appear.
    expect(names).toEqual([
      "primary",
      "background",
      "radius",
      "font-scale",
      "font-family",
    ]);
  });

  it("collects per-mode values and infers types", () => {
    const primary = model.tokens.find((token) => token.name === "primary")!;
    expect(primary.type).toBe("color");
    expect(primary.valuesByMode).toEqual({
      light: "oklch(0.5 0.19 258)",
      dark: "oklch(0.68 0.16 258)",
    });

    const radius = model.tokens.find((token) => token.name === "radius")!;
    expect(radius.type).toBe("dimension");
    expect(radius.valuesByMode).toEqual({ light: "0.625rem" });

    expect(
      model.tokens.find((token) => token.name === "font-scale")!.type,
    ).toBe("number");
    expect(
      model.tokens.find((token) => token.name === "font-family")!.type,
    ).toBe("string");
  });

  it("does not confuse .dark with a longer selector", () => {
    const css = ".darker { --x: 1px; } .dark { --primary: #000; }";
    const parsed = parseCssTokens(css, { dark: ".dark" });
    expect(parsed.tokens.map((t) => t.name)).toEqual(["primary"]);
  });
});

describe("parseJsonTokens", () => {
  it("reads a mode-keyed JSON tokens object", () => {
    const obj = {
      light: { primary: "oklch(0.5 0.19 258)", "--radius": "0.5rem" },
      dark: { primary: "oklch(0.7 0.16 258)" },
    };
    const model = parseJsonTokens(obj, ["light", "dark"]);
    expect(model.modes).toEqual(["light", "dark"]);
    const primary = model.tokens.find((t) => t.name === "primary")!;
    expect(primary.type).toBe("color");
    expect(primary.valuesByMode).toEqual({
      light: "oklch(0.5 0.19 258)",
      dark: "oklch(0.7 0.16 258)",
    });
    // Leading dashes stripped from the token name.
    expect(model.tokens.find((t) => t.name === "radius")).toBeDefined();
  });
});

describe("parseVariantOverrides", () => {
  it("parses sparse per-variant/per-mode overrides", () => {
    const overrides = parseVariantOverrides({
      forest: {
        light: { primary: "oklch(0.45 0.13 150)", "--radius": "0.375rem" },
        dark: { primary: "oklch(0.65 0.13 150)" },
      },
      sunset: { light: { ring: "oklch(0.7 0.15 35)" } },
    });
    expect(overrides).toEqual({
      forest: {
        // Leading dashes stripped on the token name.
        light: { primary: "oklch(0.45 0.13 150)", radius: "0.375rem" },
        dark: { primary: "oklch(0.65 0.13 150)" },
      },
      sunset: { light: { ring: "oklch(0.7 0.15 35)" } },
    });
  });

  it("stringifies values and drops null/undefined + non-object nodes", () => {
    const overrides = parseVariantOverrides({
      forest: { light: { scale: 1.2, skip: null }, bogus: 5 },
      broken: "nope",
    });
    // `bogus` (non-object mode) and `broken` (non-object variant) are skipped.
    expect(overrides).toEqual({
      forest: { light: { scale: "1.2" } },
    });
  });

  it("returns an empty object for non-object input", () => {
    expect(parseVariantOverrides(null)).toEqual({});
    expect(parseVariantOverrides("x")).toEqual({});
  });
});

describe("resolveTokenValue / resolveVariantModel", () => {
  const base: ThemeTokenModel = {
    modes: ["light", "dark"],
    tokens: [
      {
        name: "primary",
        type: "color",
        valuesByMode: { light: "oklch(base-l)", dark: "oklch(base-d)" },
      },
      {
        name: "radius",
        type: "dimension",
        valuesByMode: { light: "0.625rem", dark: "0.625rem" },
      },
    ],
  };
  const overrides = parseVariantOverrides({
    sunset: {
      light: { primary: "oklch(sunset-l)", radius: "1rem" },
      dark: { primary: "oklch(sunset-d)" },
    },
  });

  it("default variant resolves to base values only", () => {
    expect(resolveTokenValue(base, overrides, "default", "light", "primary")).toBe(
      "oklch(base-l)",
    );
    expect(resolveTokenValue(base, overrides, "default", "dark", "radius")).toBe(
      "0.625rem",
    );
  });

  it("uses the override where present, base as a per-token fallback", () => {
    // Overridden token/mode.
    expect(resolveTokenValue(base, overrides, "sunset", "light", "primary")).toBe(
      "oklch(sunset-l)",
    );
    // Sparse: radius has no dark override → falls back to base.
    expect(resolveTokenValue(base, overrides, "sunset", "dark", "radius")).toBe(
      "0.625rem",
    );
    // primary dark IS overridden.
    expect(resolveTokenValue(base, overrides, "sunset", "dark", "primary")).toBe(
      "oklch(sunset-d)",
    );
  });

  it("unknown variant / unknown token resolve to base / undefined", () => {
    expect(resolveTokenValue(base, overrides, "nope", "light", "primary")).toBe(
      "oklch(base-l)",
    );
    expect(
      resolveTokenValue(base, overrides, "sunset", "light", "missing"),
    ).toBeUndefined();
  });

  it("resolveVariantModel returns base unchanged for the default variant", () => {
    expect(resolveVariantModel(base, overrides, "default")).toBe(base);
  });

  it("resolveVariantModel builds the full variant+mode matrix", () => {
    const model = resolveVariantModel(base, overrides, "sunset");
    const primary = model.tokens.find((t) => t.name === "primary")!;
    const radius = model.tokens.find((t) => t.name === "radius")!;
    expect(primary.valuesByMode).toEqual({
      light: "oklch(sunset-l)",
      dark: "oklch(sunset-d)",
    });
    expect(radius.valuesByMode).toEqual({
      light: "1rem", // overridden
      dark: "0.625rem", // base fallback
    });
    // Token type is carried through from the base model.
    expect(primary.type).toBe("color");
  });
});

describe("parseRadiusScale", () => {
  it("finds the radius-scale declarations anywhere (incl. @theme)", () => {
    const css = `
@theme inline {
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
}
:root { --radius: 0.625rem; }
`;
    expect(parseRadiusScale(css)).toEqual([
      { name: "radius-sm", expr: "calc(var(--radius) * 0.6)" },
      { name: "radius-md", expr: "calc(var(--radius) * 0.8)" },
      { name: "radius-lg", expr: "var(--radius)" },
      { name: "radius-xl", expr: "calc(var(--radius) * 1.4)" },
    ]);
  });

  it("omits names that never appear and keeps the first declaration", () => {
    const css = `:root { --radius-xl: 14px; }\n.other { --radius-xl: 99px; }`;
    expect(parseRadiusScale(css)).toEqual([{ name: "radius-xl", expr: "14px" }]);
  });

  it("returns [] when no scale exists", () => {
    expect(parseRadiusScale(":root { --radius: 10px; }")).toEqual([]);
  });
});

describe("evaluateCssDimension", () => {
  const vars: Record<string, string> = {
    radius: "0.625rem",
    indirect: "var(--radius)",
    loop: "var(--loop)",
  };
  const lookup = (name: string) => vars[name];

  it("resolves plain lengths (rem/em via the 16px base)", () => {
    expect(evaluateCssDimension("10px", lookup)).toBe(10);
    expect(evaluateCssDimension("0.625rem", lookup)).toBe(10);
    expect(evaluateCssDimension("0.5em", lookup)).toBe(8);
    expect(evaluateCssDimension("0", lookup)).toBe(0);
  });

  it("resolves var() through the lookup, recursively", () => {
    expect(evaluateCssDimension("var(--radius)", lookup)).toBe(10);
    expect(evaluateCssDimension("var(--indirect)", lookup)).toBe(10);
    expect(evaluateCssDimension("var(--missing, 4px)", lookup)).toBe(4);
    expect(evaluateCssDimension("var(--missing)", lookup)).toBeUndefined();
    expect(evaluateCssDimension("var(--loop)", lookup)).toBeUndefined();
  });

  it("evaluates calc() with the demo radius-scale shapes", () => {
    expect(evaluateCssDimension("calc(var(--radius) * 1.4)", lookup)).toBe(14);
    expect(evaluateCssDimension("calc(var(--radius) * 0.6)", lookup)).toBe(6);
    expect(evaluateCssDimension("calc(var(--radius) - 4px)", lookup)).toBe(6);
    expect(evaluateCssDimension("calc(var(--radius) + 0.25rem)", lookup)).toBe(14);
    expect(evaluateCssDimension("calc((var(--radius) + 2px) / 2)", lookup)).toBe(6);
  });

  it("supports a custom rem base", () => {
    expect(evaluateCssDimension("0.625rem", lookup, 20)).toBe(12.5);
  });

  it("rejects what it cannot resolve", () => {
    expect(evaluateCssDimension("50%", lookup)).toBeUndefined();
    expect(evaluateCssDimension("calc(100% - 4px)", lookup)).toBeUndefined();
    expect(evaluateCssDimension("auto", lookup)).toBeUndefined();
    expect(evaluateCssDimension("calc(4px / 0)", lookup)).toBeUndefined();
  });
});
