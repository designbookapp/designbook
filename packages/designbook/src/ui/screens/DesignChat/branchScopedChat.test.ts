/**
 * Guards for the branch-scoped event seam (docs/specs/per-branch-sessions.md):
 * the chat binds its thread to the ACTIVE branch's session and drops other
 * branches' pi-events; inactive-branch activity surfaces only as the
 * branch-switcher badges fed by `branch-status` snapshots.
 *
 * Wire-shape compat is pinned on the server source: an ABSENT `branch` field
 * means primary — primary payloads stay byte-identical to the pre-registry
 * wire. Source-level assertions, matching the repo's other node-based UI
 * guards (noModelCallout.test.ts, figmaChatHandoff.test.ts).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toAgentStatuses } from "../../models/branch/useWorktrees";

const here = resolve(dirname(fileURLToPath(import.meta.url)));

const designChat = readFileSync(join(here, "DesignChat.tsx"), "utf8");
const api = readFileSync(resolve(here, "../../../node/api/api.ts"), "utf8");
const useWorktrees = readFileSync(
  resolve(here, "../../models/branch/useWorktrees.ts"),
  "utf8",
);
const branchSelector = readFileSync(
  resolve(here, "../BranchSelector.tsx"),
  "utf8",
);

describe("chat branch binding (DesignChat)", () => {
  it("tracks the session's branch from the state event", () => {
    expect(designChat).toContain(
      "sessionBranchRef.current = nextState.branch",
    );
  });

  it("drops pi-events from other branches BEFORE any thread fold", () => {
    const handler = designChat.match(
      /addEventListener\("pi-event"[\s\S]*?agent_start/,
    )?.[0];
    expect(handler, "pi-event handler must exist").toBeTruthy();
    expect(handler).toContain(
      "if (event.branch !== sessionBranchRef.current)",
    );
  });

  it("session badge shows the session's branch name", () => {
    expect(designChat).toContain("state.branchName");
  });
});

describe("wire shape (api.ts)", () => {
  it("primary pi-events stay untagged; branch events gain `branch`", () => {
    // The ternary keeps the primary payload BYTE-IDENTICAL (no branch key).
    expect(api).toMatch(
      /branch \? \{ \.\.\.\(event as object\), branch \} : event/,
    );
  });

  it("state carries the scoping key (absent = primary) + display name", () => {
    expect(api).toContain("branch: wireBranch(key)");
    expect(api).toContain("branchName: entry?.branchName");
  });

  it("SSE connect hydrates badges and clears the served branch's 'done'", () => {
    const handler = api.match(
      /async function handleEvents\([\s\S]*?keepAlive/,
    )?.[0];
    expect(handler, "handleEvents must exist").toBeTruthy();
    expect(handler).toContain('"branch-status"');
    expect(handler).toContain('sessions.setStatus(key, "idle")');
  });

  it("worktree list reconciles sessions + stops removed branches' servers", () => {
    expect(api).toContain("sessions.reconcile(new Set(liveBranches))");
    expect(api).toContain("worktreeProxy?.stopBranch?.(branch)");
  });
});

describe("switcher badges (useWorktrees + BranchSelector)", () => {
  it("useWorktrees listens for branch-status snapshots", () => {
    expect(useWorktrees).toContain('addEventListener("branch-status"');
  });

  it("BranchSelector renders working/done badges for non-current branches", () => {
    expect(branchSelector).toContain("agentStatuses[worktree.branch]");
    expect(branchSelector).toContain("agentWorkingBadge");
    expect(branchSelector).toContain("agentDoneBadge");
  });

  it("toAgentStatuses folds a snapshot defensively", () => {
    expect(
      toAgentStatuses({
        statuses: [
          { branch: "design/hero", status: "working" },
          { branch: "main", status: "done" },
          { branch: 42, status: "working" },
          { branch: "x", status: "unknown" },
        ],
      }),
    ).toEqual({ "design/hero": "working", main: "done" });
    expect(toAgentStatuses({})).toEqual({});
  });
});
