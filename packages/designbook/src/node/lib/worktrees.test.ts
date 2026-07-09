/**
 * Pure seams of the branch-instance flow. `instanceNavigationUrl` is what
 * host mode returns from `POST /api/worktrees` — the SERVER builds the
 * navigation URL so the UI never assembles `localhost:<port>` strings itself
 * (the regression that sent proxy-mode browsers off the stable origin).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeExcludeAddition,
  DIRTY_COUNT_CAP,
  instanceNavigationUrl,
  parseDirtyCount,
  patternPresent,
  WORKTREES_DIR_REL,
  worktreePathFor,
} from "./worktrees.ts";

describe("instanceNavigationUrl (host-mode switch target)", () => {
  it("keeps the hostname the user reached the hub with", () => {
    expect(instanceNavigationUrl("localhost:8787", 5405)).toBe(
      "http://localhost:5405/",
    );
    expect(instanceNavigationUrl("127.0.0.1:8787", 5405)).toBe(
      "http://127.0.0.1:5405/",
    );
  });

  it("handles a Host header without a port", () => {
    expect(instanceNavigationUrl("localhost", 5301)).toBe(
      "http://localhost:5301/",
    );
  });

  it("preserves bracketed IPv6 hosts", () => {
    expect(instanceNavigationUrl("[::1]:8787", 5405)).toBe(
      "http://[::1]:5405/",
    );
  });

  it("falls back to localhost for a missing or malformed Host header", () => {
    expect(instanceNavigationUrl(undefined, 5405)).toBe(
      "http://localhost:5405/",
    );
    expect(instanceNavigationUrl("not a host", 5405)).toBe(
      "http://localhost:5405/",
    );
  });
});

describe("worktreePathFor (nested worktree location)", () => {
  it("derives a path INSIDE the repo under .designbook/worktrees", () => {
    expect(worktreePathFor("/repo", "design/hero")).toBe(
      "/repo/.designbook/worktrees/design--hero",
    );
  });

  it("slugifies unsafe branch characters into the leaf only", () => {
    expect(worktreePathFor("/repo", "feat/@scope#1")).toBe(
      "/repo/.designbook/worktrees/feat--scope--1",
    );
  });

  it("no longer uses the old sibling <repo>-worktrees location", () => {
    const path = worktreePathFor("/home/me/app", "x");
    expect(path.startsWith("/home/me/app/")).toBe(true);
    expect(path).not.toContain("-worktrees");
  });
});

describe("computeExcludeAddition (auto-exclude idempotence)", () => {
  const pattern = `${WORKTREES_DIR_REL}/`;

  it("appends the pattern (with header) to an empty exclude file", () => {
    const out = computeExcludeAddition("", "", pattern);
    expect(out).toContain(pattern);
    expect(out?.endsWith("\n")).toBe(true);
  });

  it("is a no-op when the exclude file already lists it", () => {
    expect(
      computeExcludeAddition(`# stuff\n${pattern}\n`, "", pattern),
    ).toBeNull();
  });

  it("respects a matching entry already in .gitignore (writes nothing)", () => {
    expect(
      computeExcludeAddition("", ".designbook/worktrees\n", pattern),
    ).toBeNull();
    expect(computeExcludeAddition("", `${pattern}\n`, pattern)).toBeNull();
  });

  it("prefixes a newline when the exclude file lacks a trailing one", () => {
    const out = computeExcludeAddition("*.log", "", pattern);
    expect(out?.startsWith("\n")).toBe(true);
  });

  it("ignores commented and trailing-slash-variant lines correctly", () => {
    expect(patternPresent(`# ${pattern}\n`, pattern)).toBe(false);
    expect(patternPresent(".designbook/worktrees\n", pattern)).toBe(true);
  });
});

describe("parseDirtyCount (dirty badge data)", () => {
  it("counts non-empty porcelain lines", () => {
    const porcelain = " M a.tsx\n?? b.tsx\n D c.tsx\n";
    expect(parseDirtyCount(porcelain, DIRTY_COUNT_CAP)).toBe(3);
  });

  it("is 0 for a clean tree", () => {
    expect(parseDirtyCount("", DIRTY_COUNT_CAP)).toBe(0);
    expect(parseDirtyCount("\n", DIRTY_COUNT_CAP)).toBe(0);
  });

  it("caps at the provided cap for a huge tree", () => {
    const many = Array.from({ length: 500 }, (_, i) => ` M f${i}.tsx`).join(
      "\n",
    );
    expect(parseDirtyCount(many, DIRTY_COUNT_CAP)).toBe(DIRTY_COUNT_CAP);
  });
});

describe("worktree creation location (source pin)", () => {
  it("ensureWorktree builds the path via worktreePathFor and excludes it", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./worktrees.ts", import.meta.url)),
      "utf8",
    );
    // The nested location is the only source of new worktree paths…
    expect(src).toContain("worktreePathFor(repoRoot, branch)");
    expect(src).toContain("ensureWorktreesExcluded(repoRoot)");
    // …and the old sibling-dir derivation is gone.
    expect(src).not.toContain("-worktrees`");
  });
});
