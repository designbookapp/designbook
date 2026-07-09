/**
 * Path containment for the source-file routes, with the nested-worktree guard.
 *
 * Branch worktrees now live INSIDE the repo at `.designbook/worktrees/<branch>`,
 * so a path like `.designbook/worktrees/x/src/a.tsx` resolves inside the primary
 * root and would pass the plain `..`/absolute containment check — a cross-branch
 * read/write. `resolveContainedPath` rejects it. When the active root already IS
 * a worktree, its own repo-relative paths never carry that prefix, so ordinary
 * source paths still resolve under a nested root.
 */

import { describe, expect, it } from "vitest";
import { resolveContainedPath, resolveSourceFile } from "./sourcePaths.ts";

const PRIMARY = "/repo";
const WORKTREE = "/repo/.designbook/worktrees/design--hero";

describe("resolveContainedPath (primary root)", () => {
  it("resolves an ordinary in-project source path", () => {
    expect(resolveContainedPath(PRIMARY, "src/App.tsx")).toBe(
      "/repo/src/App.tsx",
    );
  });

  it("rejects absolute paths and `..` escapes", () => {
    expect(resolveContainedPath(PRIMARY, "/etc/passwd")).toBeUndefined();
    expect(resolveContainedPath(PRIMARY, "../other/x.tsx")).toBeUndefined();
  });

  it("rejects a path reaching into a nested branch worktree", () => {
    expect(
      resolveContainedPath(PRIMARY, ".designbook/worktrees/x/src/a.tsx"),
    ).toBeUndefined();
    // The worktrees dir itself, and its normalized `./` form.
    expect(
      resolveContainedPath(PRIMARY, ".designbook/worktrees"),
    ).toBeUndefined();
    expect(
      resolveContainedPath(PRIMARY, "./.designbook/worktrees/x/src/a.tsx"),
    ).toBeUndefined();
  });

  it("still allows other .designbook files (only worktrees is fenced off)", () => {
    expect(resolveContainedPath(PRIMARY, ".designbook/config.tsx")).toBe(
      "/repo/.designbook/config.tsx",
    );
  });
});

describe("resolveContainedPath (active root IS a worktree)", () => {
  it("resolves ordinary source paths under the nested worktree root", () => {
    expect(resolveSourceFile(WORKTREE, "src/App.tsx")).toBe(
      "/repo/.designbook/worktrees/design--hero/src/App.tsx",
    );
  });

  it("a worktree-rooted request cannot climb into a sibling worktree", () => {
    expect(
      resolveContainedPath(WORKTREE, "../design--pricing/src/a.tsx"),
    ).toBeUndefined();
  });
});
