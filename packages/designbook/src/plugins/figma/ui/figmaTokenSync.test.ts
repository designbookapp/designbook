/**
 * Unit tests for the figma side of the G2a inversion: neutral TokenSource in,
 * figma-specific naming/collection applied by the PLUGIN (options precedence:
 * configured integration options → deprecated theme.figma via meta → source
 * hint → default), push payload assembly, and pull diffing.
 */

import { describe, expect, it, vi } from "vitest";
import { buildNameMap } from "../shared/figmaTokens";
import type { TokenSource } from "@designbook-ui/integrations";
import {
  attributionTokens,
  collectionForPush,
  diffPulledCollection,
  resolveTokenOptions,
  splitSource,
} from "./figmaTokenSync";

function themeSource(overrides: Partial<TokenSource> = {}): TokenSource {
  return {
    id: "theme",
    collectionHint: "designbook/theme",
    modes: ["light", "dark"],
    getTokens: (): ReturnType<TokenSource["getTokens"]> => [
      {
        name: "primary",
        type: "color",
        valuesByMode: { light: "#3366ff", dark: "#001133" },
        cssVar: "primary",
      },
      {
        name: "radius",
        type: "dimension",
        valuesByMode: { light: "0.5rem", dark: "0.5rem" },
        cssVar: "radius",
      },
      {
        // Derived (radius scale): expression, no per-mode values.
        name: "radius-lg",
        type: "dimension",
        valuesByMode: {},
        cssVar: "radius-lg",
        cssValue: "calc(var(--radius) * 2)",
      },
    ],
    ...overrides,
  };
}

describe("resolveTokenOptions precedence", () => {
  it("prefers configured integration options over the legacy shim", () => {
    const source = themeSource({
      meta: { figma: { collection: "legacy" } },
    });
    const resolved = resolveTokenOptions({ collection: "configured" }, source);
    expect(resolved.collection).toBe("configured");
  });

  it("falls back to meta.figma (theme.figma deprecation shim)", () => {
    const nameRule = (token: string) => `t/${token}`;
    const source = themeSource({
      meta: { figma: { collection: "legacy", nameRule } },
    });
    const resolved = resolveTokenOptions(undefined, source);
    expect(resolved.collection).toBe("legacy");
    expect(resolved.nameRule).toBe(nameRule);
  });

  it("falls back to the source hint, then the default", () => {
    expect(resolveTokenOptions(undefined, themeSource()).collection).toBe(
      "designbook/theme",
    );
    expect(
      resolveTokenOptions(undefined, themeSource({ collectionHint: undefined }))
        .collection,
    ).toBe("designbook/theme");
    expect(resolveTokenOptions(undefined, undefined).collection).toBe(
      "designbook/theme",
    );
  });
});

describe("splitSource", () => {
  it("separates model tokens from derived cssValue expressions", () => {
    const { model, derived } = splitSource(themeSource());
    expect(model.modes).toEqual(["light", "dark"]);
    expect(model.tokens.map((t) => t.name)).toEqual(["primary", "radius"]);
    expect(derived).toEqual([
      { name: "radius-lg", expr: "calc(var(--radius) * 2)" },
    ]);
  });
});

describe("collectionForPush", () => {
  it("maps tokens through the NameMap and appends derived px FLOATs", () => {
    const nameMap = buildNameMap({ rule: (token) => `brand/${token}` });
    const collection = collectionForPush(themeSource(), "col", nameMap);
    expect(collection.name).toBe("col");
    expect(collection.modes).toEqual(["light", "dark"]);
    const names = collection.variables.map((variable) => variable.name);
    expect(names).toContain("brand/primary");
    expect(names).toContain("brand/radius");
    // Derived radius-lg: 0.5rem * 2 = 16px per mode.
    const derived = collection.variables.find(
      (variable) => variable.name === "brand/radius-lg",
    );
    expect(derived).toMatchObject({
      type: "FLOAT",
      valuesByMode: { light: 16, dark: 16 },
    });
  });
});

describe("diffPulledCollection", () => {
  it("yields only changed values and counts unmatched variables", () => {
    const nameMap = buildNameMap({});
    const source = themeSource();
    const { changes, skipped } = diffPulledCollection(
      source,
      {
        name: "designbook/theme",
        modes: ["light", "dark"],
        variables: [
          {
            name: "primary",
            type: "COLOR",
            valuesByMode: {
              // light changed, dark identical
              light: { r: 0, g: 1, b: 0, a: 1 },
              dark: { r: 0, g: 2 / 30, b: 0.2, a: 1 },
            },
          },
          { name: "not-a-token", type: "FLOAT", valuesByMode: { light: 4 } },
        ],
      },
      nameMap,
    );
    expect(skipped).toBe(1);
    expect(changes.some((c) => c.name === "primary" && c.mode === "light")).toBe(
      true,
    );
    // No writes for tokens the collection didn't change.
    expect(changes.every((c) => c.name === "primary")).toBe(true);
  });

  it("writes back through source.setToken when the caller applies changes", async () => {
    const setToken = vi.fn(async () => {});
    const source = themeSource({ setToken });
    const nameMap = buildNameMap({});
    const { changes } = diffPulledCollection(
      source,
      {
        name: "designbook/theme",
        modes: ["light"],
        variables: [
          {
            name: "primary",
            type: "COLOR",
            valuesByMode: { light: { r: 1, g: 0, b: 0, a: 1 } },
          },
        ],
      },
      nameMap,
    );
    for (const change of changes) {
      await source.setToken!(change.mode, change.name, change.value);
    }
    expect(setToken).toHaveBeenCalled();
    expect(setToken.mock.calls[0].slice(0, 2)).toEqual(["light", "primary"]);
  });
});

describe("attributionTokens", () => {
  it("maps every source token (incl. derived) to serializer rows", () => {
    const nameMap = buildNameMap({ rule: (token) => `brand/${token}` });
    const rows = attributionTokens([themeSource()], nameMap);
    expect(rows).toEqual([
      { cssVar: "primary", figmaName: "brand/primary", type: "color" },
      { cssVar: "radius", figmaName: "brand/radius", type: "dimension" },
      {
        cssVar: "radius-lg",
        figmaName: "brand/radius-lg",
        type: "dimension",
        cssValue: "calc(var(--radius) * 2)",
      },
    ]);
  });
});
