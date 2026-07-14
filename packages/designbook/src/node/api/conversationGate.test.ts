/**
 * The conversation gate (G2 restore + conversation-routed asks): the
 * session's cwd is a per-turn WORKSPACE identity — root (real writes) with
 * no active conversation, the direct-edits changeset worktree for a plain
 * prompt, the SELECTED pin's changeset worktree for a selection-scoped one.
 * Same-workspace turns never rebuild; flips rebuild when idle and defer to
 * the turn's end while busy.
 */

import { describe, expect, it } from "vitest";
import {
  createConversationGate,
  desiredGateMode,
  ROOT_WORKSPACE,
} from "./conversationGate.ts";

function fakes(initialWorkspace: string | undefined = ROOT_WORKSPACE) {
  const state = {
    /** The per-turn resolved target (api.ts turnWorkspaces + active flag). */
    desired: ROOT_WORKSPACE as string,
    workspace: initialWorkspace as string | undefined,
    busy: false,
    rebuilds: 0,
  };
  const gate = createConversationGate({
    readOnly: false,
    desiredWorkspace: () => state.desired,
    workspaceOf: () => state.workspace,
    isBusy: () => state.busy,
    rebuild: async () => {
      state.rebuilds += 1;
      // The real factory consults the same resolution at creation.
      state.workspace = state.desired;
    },
  });
  return { gate, state };
}

describe("desiredGateMode", () => {
  it("worktree only while active (and never in read-only mode)", () => {
    expect(desiredGateMode({ active: true, readOnly: false })).toBe("worktree");
    expect(desiredGateMode({ active: false, readOnly: false })).toBe("root");
    expect(desiredGateMode({ active: true, readOnly: true })).toBe("root");
  });
});

describe("conversation gate (per-turn workspaces)", () => {
  it("no active conversation: session stays at the repo root and the capture window never opens", async () => {
    const { gate, state } = fakes(ROOT_WORKSPACE);
    await gate.reconcile("k");
    expect(state.rebuilds).toBe(0); // already aligned — nothing to do
    expect(gate.captureAllowed("k")).toBe(false); // REAL writes, no commits
  });

  it("plain prompt with an active conversation: rebuilds into the DIRECT-EDITS workspace and captures", async () => {
    const { gate, state } = fakes(ROOT_WORKSPACE);
    state.desired = "cs:direct-c1";
    expect(gate.captureAllowed("k")).toBe(false); // not rebuilt yet
    await gate.reconcile("k");
    expect(state.rebuilds).toBe(1);
    expect(state.workspace).toBe("cs:direct-c1");
    expect(gate.captureAllowed("k")).toBe(true);

    // Drawer closes → back to root, capture off.
    state.desired = ROOT_WORKSPACE;
    await gate.reconcile("k");
    expect(state.rebuilds).toBe(2);
    expect(state.workspace).toBe(ROOT_WORKSPACE);
    expect(gate.captureAllowed("k")).toBe(false);
  });

  it("selection-scoped prompt: rebuilds into the PIN'S changeset workspace (per-turn binding)", async () => {
    const { gate, state } = fakes("cs:direct-c1");
    state.desired = "cs:cs-pin-hero"; // selection → the pin's changeset
    await gate.reconcile("k");
    expect(state.rebuilds).toBe(1);
    expect(state.workspace).toBe("cs:cs-pin-hero");
    expect(gate.captureAllowed("k")).toBe(true);

    // Back to a plain prompt → direct-edits again.
    state.desired = "cs:direct-c1";
    await gate.reconcile("k");
    expect(state.rebuilds).toBe(2);
    expect(state.workspace).toBe("cs:direct-c1");
  });

  it("consecutive turns on the SAME changeset workspace never rebuild", async () => {
    const { gate, state } = fakes("cs:cs-pin-hero");
    state.desired = "cs:cs-pin-hero";
    await gate.reconcile("k");
    await gate.reconcile("k");
    await gate.reconcile("k");
    expect(state.rebuilds).toBe(0);
    expect(gate.captureAllowed("k")).toBe(true);
  });

  it("a session still in ANOTHER changeset's workspace never captures (deferred flip safety)", async () => {
    const { gate, state } = fakes("cs:direct-c1");
    state.desired = "cs:cs-pin-hero";
    state.busy = true;
    await gate.reconcile("k");
    expect(state.rebuilds).toBe(0);
    expect(gate.isPending("k")).toBe(true);
    // Mid-turn: desired = pin workspace, live = direct workspace → the
    // capture must NOT open against the wrong branch.
    expect(gate.captureAllowed("k")).toBe(false);
  });

  it("defers a mid-turn flip to the turn's end (a streaming session is never torn down)", async () => {
    const { gate, state } = fakes(ROOT_WORKSPACE);
    state.desired = "cs:direct-c1";
    state.busy = true;
    await gate.reconcile("k");
    expect(state.rebuilds).toBe(0);
    expect(gate.isPending("k")).toBe(true);
    // Turn ends → the deferred flip applies.
    state.busy = false;
    gate.onTurnEnd("k");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.rebuilds).toBe(1);
    expect(state.workspace).toBe("cs:direct-c1");
    expect(gate.isPending("k")).toBe(false);
  });

  it("a flip-and-flip-back while busy resolves to a no-op at turn end", async () => {
    const { gate, state } = fakes(ROOT_WORKSPACE);
    state.busy = true;
    state.desired = "cs:direct-c1";
    await gate.reconcile("k");
    expect(gate.isPending("k")).toBe(true);
    state.desired = ROOT_WORKSPACE; // closed again before the turn ended
    await gate.reconcile("k");
    // Already aligned with the (root) workspace — pending clears, no rebuild.
    expect(gate.isPending("k")).toBe(false);
    state.busy = false;
    gate.onTurnEnd("k");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.rebuilds).toBe(0);
  });

  it("no live session (workspaceOf undefined) = nothing to rebuild — the factory decides at creation", async () => {
    let rebuilds = 0;
    const gate = createConversationGate({
      readOnly: false,
      desiredWorkspace: () => "cs:direct-c1",
      workspaceOf: () => undefined,
      isBusy: () => false,
      rebuild: async () => {
        rebuilds += 1;
      },
    });
    await gate.reconcile("k");
    expect(rebuilds).toBe(0);
    expect(gate.captureAllowed("k")).toBe(false);
  });

  it("read-only never opens the gate", async () => {
    const state = { workspace: ROOT_WORKSPACE, rebuilds: 0 };
    const gate = createConversationGate({
      readOnly: true,
      desiredWorkspace: () => "cs:direct-c1",
      workspaceOf: () => state.workspace,
      isBusy: () => false,
      rebuild: async () => {
        state.rebuilds += 1;
      },
    });
    await gate.reconcile("k");
    expect(state.rebuilds).toBe(0);
    expect(gate.captureAllowed("k")).toBe(false);
  });
});
