/**
 * The `selection` model bundles the drill / attribution / source-resolution
 * operations onto one surface. The underlying algorithms have their own
 * exhaustive suites (drillSelection.test / codeTargets.test / findUsageLine.test
 * …); this proves the MODEL binds them correctly and that `targetLine`
 * reproduces the code panel's usage-vs-definition choice — driven through the
 * canonical fixtures.
 */

import { describe, expect, it } from "vitest";
import { createSelectionModel } from "./selectionModel";
import { createSelectionFixture } from "./fixtures";

describe("createSelectionModel (bundled operations)", () => {
  it("resolves drill selection over the fixture chain", () => {
    const fx = createSelectionFixture();
    const model = createSelectionModel();

    expect(model.drillableIndices(fx.chain)).toEqual([0, 1, 2]);
    // Fresh click selects the outermost level, no drill path.
    expect(model.resolveClick(fx.chain, [])).toEqual({ index: 2, drillPath: [] });
    // Double-click descends one level, pushing the entered level's id.
    expect(model.resolveDoubleClick(fx.chain, [])).toEqual({
      kind: "descend",
      index: 1,
      drillPath: ["root"],
      entered: { chainIndex: 2 },
    });
    // Deep-click jumps to the innermost component (skips the dom leaf).
    expect(model.resolveDeepClick(fx.chain)).toEqual({
      index: 1,
      drillPath: ["root"],
    });
    // Escape pops the deepest drilled level and re-selects it.
    expect(model.resolveEscape(["root"])).toEqual({
      drillPath: [],
      selected: "root",
    });
  });

  it("attributes code targets (outermost has none, deeper carry the owner)", () => {
    const fx = createSelectionFixture();
    const model = createSelectionModel();
    const targets = model.resolveCodeTargets(fx.links);
    expect(targets[2]).toBeUndefined();
    expect(targets[1]).toMatchObject({
      file: "src/product/ProductCard.tsx",
      ownerExportName: "ProductCard",
      name: "Card",
    });
    expect(targets[0]?.className).toBe("relative");
  });

  it("resolves the highlight line: usage when drilled, definition otherwise", () => {
    const fx = createSelectionFixture();
    const model = createSelectionModel();
    // Drilled selection → its owner's `<Card className="relative">` usage line.
    expect(model.targetLine(fx.source, fx.selection)).toBe(3);
    // Plain selection → the component's own definition line.
    expect(model.targetLine(fx.source, fx.definitionSelection)).toBe(1);
    expect(model.languageFor("src/product/Card.tsx")).toBe("typescript");
  });

  it("exposes the fixture selection via the `data` seam", () => {
    const fx = createSelectionFixture();
    const model = createSelectionModel({ data: { selection: fx.selection } });
    expect(model.selection?.label).toBe("Card");
  });
});
