/**
 * Lifecycle guards for the per-branch session registry
 * (docs/specs/per-branch-sessions.md): lazy create, per-branch cwd,
 * keep-alive across switches, dispose-on-reconcile (the worktree removal
 * path), abort-on-dispose, host-mode fallback, shutdown reap. Runs against
 * fake sessions — no Pi SDK, no auth.
 */

import { describe, expect, it } from "vitest";
import {
  createSessionRegistry,
  PRIMARY_SESSION_KEY,
  resolveActiveSessionKey,
} from "./sessionRegistry.ts";

type FakeSession = {
  id: number;
  cwd: string;
  aborted: boolean;
  disposed: boolean;
  abort: () => Promise<void>;
  dispose: () => void;
};

function harness(options?: {
  resolveCwd?: (key: string) => string | undefined;
  failFor?: Set<string>;
}) {
  let nextId = 1;
  const created: Array<{ key: string; cwd: string; isPrimary: boolean }> = [];
  const unsubscribed: string[] = [];

  const registry = createSessionRegistry<FakeSession>({
    primaryCwd: "/repo",
    resolveCwd:
      options?.resolveCwd ?? ((key) => `/repo-worktrees/${key}`),
    create: async ({ key, cwd, isPrimary }) => {
      if (options?.failFor?.has(key)) {
        throw new Error(`create failed for ${key}`);
      }
      created.push({ key, cwd, isPrimary });
      const session: FakeSession = {
        id: nextId++,
        cwd,
        aborted: false,
        disposed: false,
        abort: async () => {
          session.aborted = true;
        },
        dispose: () => {
          session.disposed = true;
        },
      };
      return {
        session,
        unsubscribe: () => unsubscribed.push(key),
        branchName: isPrimary ? "main" : key,
      };
    },
  });

  return { registry, created, unsubscribed };
}

describe("active session resolution", () => {
  it("host mode / before the first switch resolves primary", () => {
    expect(
      resolveActiveSessionKey({
        activeBranch: undefined,
        activeWorktreeRoot: undefined,
        projectRoot: "/repo",
      }),
    ).toBe(PRIMARY_SESSION_KEY);
  });

  it("an active branch worktree resolves to its branch key", () => {
    expect(
      resolveActiveSessionKey({
        activeBranch: "design/hero",
        activeWorktreeRoot: "/repo-worktrees/design--hero",
        projectRoot: "/repo",
      }),
    ).toBe("design/hero");
  });

  it("switching back to the primary checkout resolves primary (same session)", () => {
    expect(
      resolveActiveSessionKey({
        activeBranch: "main",
        activeWorktreeRoot: "/repo",
        projectRoot: "/repo",
      }),
    ).toBe(PRIMARY_SESSION_KEY);
  });

  it("a branch without a known worktree root resolves primary (raw retarget)", () => {
    expect(
      resolveActiveSessionKey({
        activeBranch: "mystery",
        activeWorktreeRoot: undefined,
        projectRoot: "/repo",
      }),
    ).toBe(PRIMARY_SESSION_KEY);
  });
});

describe("session registry (per-branch-sessions spec)", () => {
  it("creates lazily, once per key, with the branch's cwd", async () => {
    const { registry, created } = harness();
    expect(created).toHaveLength(0);

    const primary = await registry.get(PRIMARY_SESSION_KEY);
    const branch = await registry.get("design/hero");
    const primaryAgain = await registry.get(PRIMARY_SESSION_KEY);

    expect(created).toEqual([
      { key: PRIMARY_SESSION_KEY, cwd: "/repo", isPrimary: true },
      {
        key: "design/hero",
        cwd: "/repo-worktrees/design/hero",
        isPrimary: false,
      },
    ]);
    expect(primaryAgain).toBe(primary);
    expect(branch).not.toBe(primary);
  });

  it("host-mode fallback: an unresolvable cwd lands on the primary cwd", async () => {
    const { registry, created } = harness({ resolveCwd: () => undefined });
    await registry.get("design/hero");
    expect(created[0].cwd).toBe("/repo");
  });

  it("keeps sessions alive across switches (no implicit dispose)", async () => {
    const { registry } = harness();
    const a = await registry.get("a");
    await registry.get("b");
    const aAgain = await registry.get("a");
    expect(aAgain).toBe(a);
    expect(a.disposed).toBe(false);
    expect(a.aborted).toBe(false);
  });

  it("dispose aborts the in-flight turn, unsubscribes, and disposes", async () => {
    const { registry, unsubscribed } = harness();
    const session = await registry.get("a");
    await registry.dispose("a");
    expect(session.aborted).toBe(true);
    expect(session.disposed).toBe(true);
    expect(unsubscribed).toEqual(["a"]);
    // A fresh get() builds a NEW session.
    const next = await registry.get("a");
    expect(next).not.toBe(session);
  });

  it("reconcile disposes sessions for removed worktrees, never the primary", async () => {
    const { registry } = harness();
    const primary = await registry.get(PRIMARY_SESSION_KEY);
    const kept = await registry.get("kept");
    const removed = await registry.get("removed");

    const disposedKeys = registry.reconcile(new Set(["kept", "main"]));
    // dispose is async fire-and-forget inside reconcile; flush microtasks.
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    expect(disposedKeys).toEqual(["removed"]);
    expect(removed.disposed).toBe(true);
    expect(kept.disposed).toBe(false);
    expect(primary.disposed).toBe(false);
    expect(registry.keys().sort()).toEqual([PRIMARY_SESSION_KEY, "kept"]);
  });

  it("a failed create clears the entry so the next get retries", async () => {
    const failFor = new Set(["a"]);
    const { registry } = harness({ failFor });
    await expect(registry.get("a")).rejects.toThrow("create failed for a");
    failFor.delete("a");
    const session = await registry.get("a");
    expect(session.cwd).toBe("/repo-worktrees/a");
  });

  it("disposeAll reaps every session (shutdown)", async () => {
    const { registry } = harness();
    const sessions = await Promise.all([
      registry.get(PRIMARY_SESSION_KEY),
      registry.get("a"),
      registry.get("b"),
    ]);
    await registry.disposeAll();
    for (const session of sessions) {
      expect(session.aborted).toBe(true);
      expect(session.disposed).toBe(true);
    }
    expect(registry.keys()).toEqual([]);
  });

  it("statuses reports display branch names, non-idle only", async () => {
    const { registry } = harness();
    await registry.get(PRIMARY_SESSION_KEY);
    await registry.get("design/hero");
    expect(registry.statuses()).toEqual([]);

    registry.setStatus(PRIMARY_SESSION_KEY, "working");
    registry.setStatus("design/hero", "done");
    expect(registry.statuses()).toEqual([
      { branch: "main", status: "working" },
      { branch: "design/hero", status: "done" },
    ]);

    registry.setStatus(PRIMARY_SESSION_KEY, "idle");
    expect(registry.statuses()).toEqual([
      { branch: "design/hero", status: "done" },
    ]);
  });
});
