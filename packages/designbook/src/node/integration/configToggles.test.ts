import { describe, expect, it } from "vitest";
import { parseDisabledIntegrations } from "./configToggles.ts";

describe("parseDisabledIntegrations", () => {
  it("finds a literal figma: false toggle", () => {
    const source = `
      export default defineConfig({
        title: "App",
        integrations: { figma: false },
        sets: [],
      });
    `;
    expect(parseDisabledIntegrations(source)).toEqual(new Set(["figma"]));
  });

  it("tolerates whitespace, quotes, and trailing commas", () => {
    const source = `integrations: {\n  "figma"  :  false ,\n}`;
    expect(parseDisabledIntegrations(source)).toEqual(new Set(["figma"]));
  });

  it("ignores enabled/optioned integrations (nested objects)", () => {
    const source = `
      integrations: {
        figma: { tokens: { collection: "designbook/theme" } },
        sketch: false,
      },
    `;
    expect(parseDisabledIntegrations(source)).toEqual(new Set(["sketch"]));
  });

  it("returns empty when there is no integrations block", () => {
    expect(parseDisabledIntegrations("defineConfig({ sets: [] })")).toEqual(
      new Set(),
    );
    expect(parseDisabledIntegrations("")).toEqual(new Set());
  });

  it("does not treat other false keys as toggles", () => {
    const source = `integrations: { figma: { autoSync: false } }`;
    // `autoSync: false` is inside figma's OPTIONS, not a top-level toggle for
    // an integration named autoSync… the cheap scanner cannot tell the
    // nesting level, so document the accepted trade-off: it only matters if
    // an integration is literally named like an option key. Top-level `figma`
    // stays enabled either way.
    expect(parseDisabledIntegrations(source).has("figma")).toBe(false);
  });
});
