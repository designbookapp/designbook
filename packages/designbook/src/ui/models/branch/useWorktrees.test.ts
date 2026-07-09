/**
 * The branch-switch navigation seam (C3.2 regression guard). The server owns
 * the destination URL for a branch switch; the UI only appends its route hash
 * in hash-routing (host) mode. Includes a source scan pinning that the branch
 * UI never string-builds `localhost:<port>` origins again — that is exactly
 * the bug that sent proxy-mode browsers off the stable origin onto raw
 * instance ports.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  shouldAutoSwitchBranch,
  switchNavigationTarget,
} from "./useWorktrees";

describe("switchNavigationTarget", () => {
  it("proxy mode: stays on the same-origin path the server returned", () => {
    // Injected workbenches use memory routing; the route survives the reload
    // via sessionStorage, so no hash is appended.
    expect(
      switchNavigationTarget("/__designbook", "b/design%2Fhero", "memory"),
    ).toBe("/__designbook");
  });

  it("host mode: appends the route hash to the server-built instance url", () => {
    expect(
      switchNavigationTarget(
        "http://localhost:5405/",
        "b/design%2Fhero/component/x",
        "hash",
      ),
    ).toBe("http://localhost:5405/#b/design%2Fhero/component/x");
  });
});

describe("shouldAutoSwitchBranch (no silent revert after a proxy switch)", () => {
  it("memory (injected) routing NEVER auto-switches from the route branch", () => {
    // The memory route's branch is restored from the reload-persist blob,
    // which is stale right after a proxy branch switch — auto-switching on it
    // silently reverted the user's switch ("switched back to main" bug).
    expect(shouldAutoSwitchBranch("memory", "main", "design/hero")).toBe(false);
    expect(shouldAutoSwitchBranch("memory", "design/hero", "main")).toBe(false);
  });

  it("hash mode: an explicit #/b/<branch> deep link drives a switch", () => {
    expect(shouldAutoSwitchBranch("hash", "design/hero", "main")).toBe(true);
  });

  it("hash mode: no switch when the branches already agree", () => {
    expect(shouldAutoSwitchBranch("hash", "main", "main")).toBe(false);
  });

  it("no switch while either branch is still unknown", () => {
    expect(shouldAutoSwitchBranch("hash", undefined, "main")).toBe(false);
    expect(shouldAutoSwitchBranch("hash", "main", undefined)).toBe(false);
  });
});

describe("workbench routes the auto-switch through the guard (source scan)", () => {
  const branchDir = dirname(fileURLToPath(import.meta.url));
  const workbenchPath = join(branchDir, "..", "..", "screens", "Workbench.tsx");

  it("Workbench.tsx uses shouldAutoSwitchBranch, not a raw branch comparison", () => {
    const text = readFileSync(workbenchPath, "utf8");
    expect(
      text,
      "the route-driven switch must go through shouldAutoSwitchBranch (memory mode must never auto-switch)",
    ).toMatch(/shouldAutoSwitchBranch\(/);
    expect(
      text,
      "no raw urlBranch !== currentBranch switching (that is the silent-revert bug)",
    ).not.toMatch(/urlBranch\s*!==?\s*currentBranch/);
  });
});

describe("branch UI never assembles host:port URLs (source scan)", () => {
  const branchDir = dirname(fileURLToPath(import.meta.url));

  it("has no raw localhost/hostname/port URL building in branch model sources", () => {
    const sources = readdirSync(branchDir).filter(
      (name) =>
        /\.(ts|tsx)$/.test(name) &&
        !name.includes(".test.") &&
        name !== "fixtures.ts",
    );
    expect(sources.length).toBeGreaterThan(0);

    for (const name of sources) {
      const text = readFileSync(join(branchDir, name), "utf8");
      expect(text, `${name} must not hardcode localhost origins`).not.toMatch(
        /localhost:/,
      );
      expect(
        text,
        `${name} must not rebuild origins from window.location.hostname`,
      ).not.toMatch(/location\.hostname/);
      expect(
        text,
        `${name} must not template an http origin from a port (the server returns the url)`,
      ).not.toMatch(/http:\/\/\$\{/);
    }
  });
});
