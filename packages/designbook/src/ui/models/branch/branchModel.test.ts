/**
 * The `branch` model — worktree state exposure, injected switch/retry routing,
 * and the no-git `showSelector` degrade — exercised through the canonical
 * fixtures. Pure/DOM-free (the live fetch + full-page navigation live in
 * `useWorktrees`, covered by the e2e), so this drives the seam the selector
 * consumes.
 */

import { describe, expect, it } from "vitest";
import { createBranchModel } from "./branchModel";
import { createBranchFixture, createEmptyBranchFixture } from "./fixtures";

describe("createBranchModel (fixture / data mode)", () => {
  it("exposes the worktree state slice", () => {
    const fx = createBranchFixture();
    const model = createBranchModel({ data: fx.data });
    expect(model.currentBranch).toBe("main");
    expect(model.worktrees).toHaveLength(3);
    expect(model.showSelector).toBe(true);
  });

  it("routes switchBranch and retry through the injected actions", () => {
    const fx = createBranchFixture();
    const model = createBranchModel({
      data: fx.data,
      switchBranch: fx.switchBranch,
      retry: fx.retry,
    });
    model.switchBranch("design/hero");
    model.switchBranch("design/pricing");
    model.retry();
    expect(fx.switches).toEqual(["design/hero", "design/pricing"]);
    expect(fx.retries).toBe(1);
  });

  it("defaults the actions to no-ops when omitted", () => {
    const model = createBranchModel({ data: createBranchFixture().data });
    expect(() => {
      model.switchBranch("x");
      model.retry();
    }).not.toThrow();
  });
});

describe("showSelector (no-git degrade)", () => {
  it("hides the selector once loaded with no branch and no worktrees", () => {
    const model = createBranchModel({ data: createEmptyBranchFixture().data });
    expect(model.showSelector).toBe(false);
  });

  it("shows the selector while still loading (before the fetch settles)", () => {
    const model = createBranchModel({
      data: { worktrees: [], loaded: false, switching: false },
    });
    expect(model.showSelector).toBe(true);
  });

  it("shows the selector when worktrees exist but no current branch yet", () => {
    const fx = createBranchFixture();
    const model = createBranchModel({
      data: { ...fx.data, currentBranch: undefined },
    });
    expect(model.showSelector).toBe(true);
  });
});
