/**
 * The `catalog` model's slices, lookups, and `navigate` action, exercised
 * through the canonical fixtures. Pure (no React/DOM), matching the pilot's
 * node-mode factory test — the atoms are thin, so a provider render test would
 * add nothing over driving the factory directly.
 */

import { describe, expect, it } from "vitest";
import { createCatalogModel } from "./catalogModel";
import { createCatalogFixture } from "./fixtures";

describe("createCatalogModel (fixture / data mode)", () => {
  it("exposes the config slices verbatim", () => {
    const fx = createCatalogFixture();
    const model = createCatalogModel({ data: fx.data });
    expect(model.entries).toHaveLength(3);
    expect(model.flows.map((f) => f.id)).toEqual(["ship", "product"]);
    expect(model.sets.map((s) => s.id)).toEqual(["ship", "product"]);
    expect(model.viewports[0].width).toBe(1280);
  });

  it("looks up entries by id and by set", () => {
    const fx = createCatalogFixture();
    const model = createCatalogModel({ data: fx.data });
    expect(model.getEntry("product.Card")).toBe(fx.entries.productCard);
    expect(model.getEntry("nope")).toBeUndefined();
    expect(model.getSetEntries("ship").map((e) => e.id)).toEqual([
      "ship.Detail",
      "ship.Summary",
    ]);
  });

  it("resolves flows, flow-for-screen, and a flow screen", () => {
    const fx = createCatalogFixture();
    const model = createCatalogModel({ data: fx.data });
    expect(model.getFlow("ship")?.screens).toHaveLength(2);
    expect(model.getFlowForScreen("product.Card")?.id).toBe("product");
    expect(model.getFlowScreen("ship.Summary")?.label).toBe("Summary");
    expect(model.getFlowScreen("missing")).toBeUndefined();
  });

  it("synthesizes a flow screen from a registry entry", () => {
    const fx = createCatalogFixture();
    const model = createCatalogModel({ data: fx.data });
    expect(model.screenFor("ship.Detail")).toEqual({
      id: "ship.Detail",
      label: "Ship · Detail",
      description: "src/ship/Detail.tsx",
      registryId: "ship.Detail",
    });
    expect(model.screenFor("nope")).toBeUndefined();
  });

  it("routes the navigate action to the injected callback", () => {
    const fx = createCatalogFixture();
    const model = createCatalogModel({ data: fx.data, navigate: fx.navigate });
    model.navigate(["product.Card"]);
    model.navigate([], "ship");
    expect(fx.navigated).toEqual([
      { nodeIds: ["product.Card"], flowId: undefined },
      { nodeIds: [], flowId: "ship" },
    ]);
  });

  it("navigate defaults to a no-op when none is injected (cell mode)", () => {
    const fx = createCatalogFixture();
    const model = createCatalogModel({ data: fx.data });
    expect(() => model.navigate(["x"])).not.toThrow();
  });

  it("exposes an empty route by default and the supplied route when given", () => {
    const fx = createCatalogFixture();
    const empty = createCatalogModel({ data: fx.data });
    expect(empty.nodeIds).toEqual([]);
    expect(empty.flowId).toBeUndefined();
    expect(empty.appPath).toBeUndefined();
    expect(empty.branch).toBeUndefined();

    const routed = createCatalogModel({
      data: fx.data,
      route: {
        branch: "main",
        urlBranch: "main",
        flowId: "product",
        nodeIds: ["product.Card"],
        appPath: undefined,
        sandboxPinId: undefined,
      },
    });
    expect(routed.branch).toBe("main");
    expect(routed.urlBranch).toBe("main");
    expect(routed.flowId).toBe("product");
    expect(routed.nodeIds).toEqual(["product.Card"]);
  });

  it("routes navigateApp to the injected callback (and no-ops by default)", () => {
    const fx = createCatalogFixture();
    const opened: string[] = [];
    const model = createCatalogModel({
      data: fx.data,
      navigateApp: (path) => void opened.push(path),
    });
    model.navigateApp("/products");
    model.navigateApp("/cart");
    expect(opened).toEqual(["/products", "/cart"]);

    const noop = createCatalogModel({ data: fx.data });
    expect(() => noop.navigateApp("/x")).not.toThrow();
  });
});
