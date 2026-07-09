import { describe, expect, it } from "vitest";
import {
  buildHash,
  parseHashString,
  reconcileRouteBranch,
} from "@designbook-ui/models/catalog/useCanvasRoute";

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

describe("reconcileRouteBranch (memory route follows the server after a proxy switch)", () => {
  const staleRoute = {
    branch: "main",
    flowId: "booking",
    nodeIds: ["product.Card"],
    appPath: undefined,
  };

  it("memory mode: snaps a stale persisted branch to the live one, keeping the rest", () => {
    // The exact post-switch reload state: the persist blob still says "main",
    // the server is already on the new branch. Without this, the workbench
    // auto-switched back — the "switched back to main" bug.
    expect(reconcileRouteBranch(staleRoute, "design/hero", true)).toEqual({
      ...staleRoute,
      branch: "design/hero",
    });
  });

  it("no-op when the branches already agree", () => {
    expect(reconcileRouteBranch(staleRoute, "main", true)).toBeUndefined();
  });

  it("no-op when the route has no branch yet (fresh session)", () => {
    expect(
      reconcileRouteBranch(
        { branch: undefined, flowId: undefined, nodeIds: [] },
        "main",
        true,
      ),
    ).toBeUndefined();
  });

  it("no-op while the server branch is still unknown", () => {
    expect(reconcileRouteBranch(staleRoute, undefined, true)).toBeUndefined();
  });

  it("hash mode never reconciles (its URL branch is an explicit deep link)", () => {
    expect(
      reconcileRouteBranch(staleRoute, "design/hero", false),
    ).toBeUndefined();
  });
});
