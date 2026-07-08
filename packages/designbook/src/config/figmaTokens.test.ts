import { describe, expect, it } from "vitest";
import {
  buildNameMap,
  collectionToTokens,
  derivedDimensionsToVariables,
  tokensToCollection,
  type FigmaCollection,
} from "./figmaTokens";
import { oklchToRgb, parseOklch } from "./color";
import type { ThemeTokenModel } from "./themeTokens";

const model: ThemeTokenModel = {
  modes: ["light", "dark"],
  tokens: [
    {
      name: "primary",
      type: "color",
      valuesByMode: {
        light: "oklch(0.5 0.19 258)",
        dark: "oklch(0.68 0.16 258)",
      },
    },
    { name: "radius", type: "dimension", valuesByMode: { light: "0.625rem" } },
    { name: "font-scale", type: "number", valuesByMode: { light: "1.2" } },
    { name: "font-family", type: "string", valuesByMode: { light: "Inter" } },
  ],
};

describe("tokensToCollection", () => {
  const collection = tokensToCollection(model, {
    collection: "designbook/theme",
    nameMap: buildNameMap({}),
  });

  it("carries the collection name + modes", () => {
    expect(collection.name).toBe("designbook/theme");
    expect(collection.modes).toEqual(["light", "dark"]);
  });

  it("maps token types to Figma variable types", () => {
    const byName = Object.fromEntries(
      collection.variables.map((variable) => [variable.name, variable.type]),
    );
    expect(byName.primary).toBe("COLOR");
    expect(byName.radius).toBe("FLOAT");
    expect(byName["font-scale"]).toBe("FLOAT");
    expect(byName["font-family"]).toBe("STRING");
  });

  it("converts colors to {r,g,b,a} matching oklch→rgb", () => {
    const primary = collection.variables.find((v) => v.name === "primary")!;
    const expected = oklchToRgb(parseOklch("oklch(0.5 0.19 258)")!);
    expect(primary.valuesByMode.light).toEqual(expected);
  });

  it("projects dimensions to px (rem × 16) and keeps numbers numeric", () => {
    // A rem-valued FLOAT (0.625) would render a 0.625px radius when bound to
    // a node field — dimension variables are px in Figma by decision.
    const radius = collection.variables.find((v) => v.name === "radius")!;
    expect(radius.valuesByMode.light).toBe(10);
    const scale = collection.variables.find((v) => v.name === "font-scale")!;
    expect(scale.valuesByMode.light).toBe(1.2);
  });

  it("passes strings through", () => {
    const family = collection.variables.find((v) => v.name === "font-family")!;
    expect(family.valuesByMode.light).toBe("Inter");
  });
});

describe("collectionToTokens", () => {
  it("is non-destructive and re-attaches dimension units", () => {
    const incoming: FigmaCollection = {
      name: "designbook/theme",
      modes: ["light", "dark"],
      variables: [
        {
          name: "primary",
          type: "COLOR",
          // A visibly different primary (green-ish) in light mode only.
          valuesByMode: { light: oklchToRgb(parseOklch("oklch(0.5 0.15 150)")!) },
        },
        { name: "radius", type: "FLOAT", valuesByMode: { light: 16 } },
        // A Figma variable with no matching token — must be ignored.
        { name: "orphan", type: "FLOAT", valuesByMode: { light: 5 } },
      ],
    };

    const next = collectionToTokens(incoming, model, buildNameMap({}));

    // Same shape: same modes + tokens, none invented or deleted.
    expect(next.modes).toEqual(model.modes);
    expect(next.tokens.map((t) => t.name)).toEqual(
      model.tokens.map((t) => t.name),
    );

    const primary = next.tokens.find((t) => t.name === "primary")!;
    // light updated to the pulled color…
    expect(primary.valuesByMode.light.startsWith("oklch(")).toBe(true);
    expect(primary.valuesByMode.light).not.toBe("oklch(0.5 0.19 258)");
    // …dark untouched (variable had no dark value).
    expect(primary.valuesByMode.dark).toBe("oklch(0.68 0.16 258)");

    // Dimension unit re-attached, px scaled back to the token's rem unit.
    const radius = next.tokens.find((t) => t.name === "radius")!;
    expect(radius.valuesByMode.light).toBe("1rem");

    // Untouched tokens keep their values.
    expect(
      next.tokens.find((t) => t.name === "font-family")!.valuesByMode.light,
    ).toBe("Inter");
  });

  it("round-trips a rem dimension exactly (px out, rem back)", () => {
    const pushed = tokensToCollection(model, {
      collection: "c",
      nameMap: buildNameMap({}),
    });
    const pulled = collectionToTokens(pushed, model, buildNameMap({}));
    const radius = pulled.tokens.find((t) => t.name === "radius")!;
    expect(radius.valuesByMode.light).toBe("0.625rem");
  });

  it("round-trips a color pull close to the original", () => {
    const pushed = tokensToCollection(model, {
      collection: "c",
      nameMap: buildNameMap({}),
    });
    const pulled = collectionToTokens(pushed, model, buildNameMap({}));
    const primary = pulled.tokens.find((t) => t.name === "primary")!;
    const before = parseOklch("oklch(0.5 0.19 258)")!;
    const after = parseOklch(primary.valuesByMode.light)!;
    expect(Math.abs(after.L - before.L)).toBeLessThan(0.01);
    expect(Math.abs(after.C - before.C)).toBeLessThan(0.01);
    expect(Math.abs(after.H - before.H)).toBeLessThan(1);
  });
});

describe("buildNameMap", () => {
  it("defaults to identity", () => {
    const map = buildNameMap({});
    expect(map.toFigma("primary")).toBe("primary");
    expect(map.toToken("primary")).toBe("primary");
  });

  it("applies a rule", () => {
    const map = buildNameMap({ rule: (t) => `theme/${t}` });
    expect(map.toFigma("primary")).toBe("theme/primary");
  });

  it("lets overrides win in both directions", () => {
    const map = buildNameMap({
      rule: (t) => `theme/${t}`,
      overrides: { primary: "Brand/Primary" },
    });
    expect(map.toFigma("primary")).toBe("Brand/Primary");
    expect(map.toToken("Brand/Primary")).toBe("primary");
    // Non-overridden names still use the rule / identity inverse.
    expect(map.toFigma("radius")).toBe("theme/radius");
    expect(map.toToken("radius")).toBe("radius");
  });
});

describe("derivedDimensionsToVariables", () => {
  const scale = [
    { name: "radius-sm", expr: "calc(var(--radius) * 0.6)" },
    { name: "radius-md", expr: "calc(var(--radius) * 0.8)" },
    { name: "radius-lg", expr: "var(--radius)" },
    { name: "radius-xl", expr: "calc(var(--radius) * 1.4)" },
  ];

  it("evaluates the scale per mode into px FLOAT variables", () => {
    const twoMode: ThemeTokenModel = {
      modes: ["light", "dark"],
      tokens: [
        {
          name: "radius",
          type: "dimension",
          valuesByMode: { light: "0.625rem", dark: "0.5rem" },
        },
      ],
    };
    const variables = derivedDimensionsToVariables(
      scale,
      twoMode,
      buildNameMap({}),
    );
    expect(variables).toEqual([
      { name: "radius-sm", type: "FLOAT", valuesByMode: { light: 6, dark: 4.8 } },
      { name: "radius-md", type: "FLOAT", valuesByMode: { light: 8, dark: 6.4 } },
      { name: "radius-lg", type: "FLOAT", valuesByMode: { light: 10, dark: 8 } },
      { name: "radius-xl", type: "FLOAT", valuesByMode: { light: 14, dark: 11.2 } },
    ]);
  });

  it("applies the name map and skips model-token collisions", () => {
    const withCollision: ThemeTokenModel = {
      modes: ["light"],
      tokens: [
        { name: "radius", type: "dimension", valuesByMode: { light: "10px" } },
        // A real token already named radius-sm — the model wins.
        { name: "radius-sm", type: "dimension", valuesByMode: { light: "3px" } },
      ],
    };
    const variables = derivedDimensionsToVariables(
      scale,
      withCollision,
      buildNameMap({ rule: (t) => `theme/${t}` }),
    );
    expect(variables.map((v) => v.name)).toEqual([
      "theme/radius-md",
      "theme/radius-lg",
      "theme/radius-xl",
    ]);
  });

  it("drops expressions that resolve in no mode", () => {
    const noRadius: ThemeTokenModel = { modes: ["light"], tokens: [] };
    expect(
      derivedDimensionsToVariables(scale, noRadius, buildNameMap({})),
    ).toEqual([]);
  });
});
