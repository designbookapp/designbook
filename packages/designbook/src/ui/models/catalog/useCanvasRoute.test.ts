import { describe, expect, it } from "vitest";
import { buildHash, parseHashString } from "@designbook-ui/models/catalog/useCanvasRoute";

describe("app route", () => {
  it("builds an app hash carrying the path", () => {
    expect(buildHash("main", [], undefined, "/trips")).toBe(
      "/b/main/app/%2Ftrips",
    );
  });

  it("round-trips a path with a query string", () => {
    const hash = buildHash("main", [], undefined, "/search?q=coastal");
    const route = parseHashString(`#${hash}`);
    expect(route).toEqual({
      branch: "main",
      flowId: undefined,
      nodeIds: [],
      appPath: "/search?q=coastal",
    });
  });

  it("round-trips without a branch", () => {
    const hash = buildHash(undefined, [], undefined, "/trips/coastal-trail");
    const route = parseHashString(`#${hash}`);
    expect(route.appPath).toBe("/trips/coastal-trail");
    expect(route.branch).toBeUndefined();
  });

  it("app segment wins over nodeIds/flowId when appPath is set", () => {
    const hash = buildHash("main", ["some.Entry"], "someFlow", "/checkout");
    expect(hash).toBe("/b/main/app/%2Fcheckout");
  });

  it("defaults to the root when no path segment follows 'app'", () => {
    const route = parseHashString("#/b/main/app");
    expect(route.appPath).toBe("/");
  });

  it("a non-app route has no appPath", () => {
    const route = parseHashString("#/b/main/component/product.Card");
    expect(route.appPath).toBeUndefined();
  });
});
