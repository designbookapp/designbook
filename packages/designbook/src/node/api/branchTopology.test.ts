/**
 * Branch-topology regressions (docs/specs/per-branch-sessions.md ×
 * docs/specs/changesets-on-git.md) — the live bug: a sandbox pin ask on a
 * NON-PRIMARY branch (per-branch worktree under `.designbook/worktrees/`)
 * completed server-side but its events were tagged with whatever branch was
 * ACTIVE at emit time, and a git-TRACKED sandbox index let the first home to
 * revive claim every shared pin id — a retry then ran against the WRONG repo
 * root entirely.
 *
 * Real repos (primary checkout + a linked branch worktree, changeset
 * worktrees nested inside it), fake turns — the sandbox.test.ts harness
 * pattern.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxOrchestrator, type SandboxRunTurn } from "./sandbox.ts";
import { resolveSandboxWireBranch } from "./sessionRegistry.ts";
import { refTrunk } from "../overrides/gitChangesets.ts";

const execFileAsync = promisify(execFile);

const cleanups: string[] = [];
const settlers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (settlers.length > 0) {
    await settlers.pop()!();
  }
  while (cleanups.length > 0) {
    const root = cleanups.pop()!;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
});

async function sh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function gitCommitAll(root: string, message = "setup"): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      message,
      "--allow-empty",
    ],
    { cwd: root },
  );
}

/** Primary repo (main) + a LINKED branch worktree at the real per-branch
 * location: `<primary>/.designbook/worktrees/<slug>` on branch `design/x` —
 * changeset worktrees then nest under the BRANCH root (the live topology). */
async function makeBranchTopology(): Promise<{
  primary: string;
  branchRoot: string;
  branch: string;
}> {
  const primary = await mkdtemp(join(tmpdir(), "db-branchtopo-"));
  cleanups.push(primary);
  await mkdir(join(primary, "src"), { recursive: true });
  await writeFile(
    join(primary, "src/Card.tsx"),
    "export function ProductCard() { return null; }\n",
  );
  await execFileAsync("git", ["init", "-q", "-b", "main", primary]);
  await gitCommitAll(primary, "init");
  const branch = "design/x";
  const branchRoot = join(primary, ".designbook/worktrees/design--x");
  await mkdir(dirname(branchRoot), { recursive: true });
  await execFileAsync(
    "git",
    ["worktree", "add", "-q", "-b", branch, branchRoot],
    { cwd: primary },
  );
  return { primary, branchRoot, branch };
}

type Emitted = {
  type?: string;
  __home?: { repoRoot?: string; branch?: string };
  [key: string]: unknown;
};

function harness(runTurn: SandboxRunTurn) {
  const events: Emitted[] = [];
  const turnCalls: Array<Parameters<SandboxRunTurn>[0]> = [];
  const orchestrator = createSandboxOrchestrator({
    runTurn: async (params) => {
      turnCalls.push(params);
      return runTurn(params);
    },
    runTypecheck: async () => ({ ok: true }),
    broadcast: (eventName, payload) => {
      if (eventName === "sandbox-event") events.push(payload as Emitted);
    },
    log: () => {},
    sleep: async () => {},
  });
  settlers.push(() => orchestrator.settle());
  return { events, orchestrator, turnCalls };
}

const TARGET = {
  file: "src/Card.tsx",
  exportName: "ProductCard",
  name: "Product Card",
};

type FakeTurnParams = Parameters<SandboxRunTurn>[0];
async function agentWrite(
  params: FakeTurnParams,
  rel: string,
  content: string,
): Promise<void> {
  const abs = join(params.cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  await params.capture?.noteToolEnd({
    toolCallId: `t-${Math.random().toString(36).slice(2, 8)}`,
    toolName: "write",
  });
}

/** Ask-shaped fake turns: classifier says "no variants", the edit turn
 * writes the target, titles are stable. */
function editTurns(content: string): SandboxRunTurn {
  return async (params) => {
    if (params.mode === "intent") return { text: '{"variants":false}' };
    if (params.mode === "title") return { text: "Branch ask" };
    await agentWrite(params, TARGET.file, content);
    return { text: "done" };
  };
}

async function until(
  predicate: () => boolean,
  label: string,
  tries = 400,
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("branch topology: event tagging (the ask's OWN home)", () => {
  it("every event of a branch-home ask carries the BRANCH home, and the wire tag derives from it (not the active session)", async () => {
    const { primary, branchRoot, branch } = await makeBranchTopology();
    const { events, orchestrator, turnCalls } = harness(
      editTurns("export function ProductCard(){return 'branch';}\n"),
    );

    const created = await orchestrator.createPin({
      repoRoot: branchRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    expect(created.error).toBeUndefined();
    const pinId = created.id!;
    expect(
      orchestrator.ask({
        pinId,
        prompt: "ghost button please",
        repoRoot: branchRoot,
        appDir: "",
      }).error,
    ).toBeUndefined();
    await until(
      () => events.some((event) => event.type === "turn-end"),
      "turn-end",
    );

    // EVERY event of this ask names the branch home — completion events
    // included (the live bug: completion tagged with emit-time active
    // state and dropped by the branch-filtered client).
    const askEvents = events.filter((event) => event.pinId === pinId);
    expect(askEvents.length).toBeGreaterThan(3);
    for (const event of askEvents) {
      expect(event.__home?.repoRoot).toBe(branchRoot);
      expect(event.__home?.branch).toBe(branch);
    }
    // …and api.ts maps that home to the wire tag: branch home → tagged,
    // regardless of the ACTIVE session at completion time.
    for (const event of askEvents) {
      expect(
        resolveSandboxWireBranch({
          homeRepoRoot: event.__home!.repoRoot!,
          homeBranch: event.__home!.branch,
          projectRoot: primary,
          activeWireBranch: undefined, // viewer switched back to primary
        }),
      ).toBe(branch);
    }

    // The turn ran in a changeset worktree NESTED under the branch root.
    const editCall = turnCalls.find((call) => call.mode === "edit")!;
    expect(
      editCall.cwd.startsWith(join(branchRoot, ".designbook/worktrees/")),
    ).toBe(true);
    // The hidden ref advanced from the BRANCH's HEAD.
    const csId = `cs-${pinId}`;
    const base = await sh(primary, [
      "rev-parse",
      `refs/designbook/changesets/${csId}/base`,
    ]);
    expect(base).toBe(await sh(branchRoot, ["rev-parse", "HEAD"]));
    // The projection landed under the BRANCH root, not the primary.
    expect(
      existsSync(join(branchRoot, `.designbook/changesets/${csId}`)),
    ).toBe(true);
    expect(
      existsSync(join(primary, `.designbook/changesets/${csId}`)),
    ).toBe(false);
  });

  it("resolveSandboxWireBranch: primary home untagged; branch home tagged; probe-less home falls back", () => {
    expect(
      resolveSandboxWireBranch({
        homeRepoRoot: "/repo",
        homeBranch: "main",
        projectRoot: "/repo",
        activeWireBranch: "design/x",
      }),
    ).toBeUndefined();
    expect(
      resolveSandboxWireBranch({
        homeRepoRoot: "/repo/.designbook/worktrees/design--x",
        homeBranch: "design/x",
        projectRoot: "/repo",
        activeWireBranch: undefined,
      }),
    ).toBe("design/x");
    expect(
      resolveSandboxWireBranch({
        homeRepoRoot: "/repo/.designbook/worktrees/design--x",
        homeBranch: undefined,
        projectRoot: "/repo",
        activeWireBranch: "design/x",
      }),
    ).toBe("design/x");
  });
});

describe("branch topology: back-to-back asks", () => {
  it("a second ask on the same changeset turns (busy released, trunk advances again)", async () => {
    const { branchRoot } = await makeBranchTopology();
    let revision = 0;
    const { events, orchestrator } = harness(async (params) => {
      if (params.mode === "intent") return { text: '{"variants":false}' };
      if (params.mode === "title") return { text: "Two asks" };
      revision += 1;
      await agentWrite(
        params,
        TARGET.file,
        `export function ProductCard(){return ${revision};}\n`,
      );
      return { text: "done" };
    });
    const { id } = await orchestrator.createPin({
      repoRoot: branchRoot,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    const csId = `cs-${id}`;

    expect(
      orchestrator.ask({
        pinId: id!,
        prompt: "first",
        repoRoot: branchRoot,
        appDir: "",
      }).error,
    ).toBeUndefined();
    await until(
      () => events.filter((event) => event.type === "turn-end").length === 1,
      "first turn-end",
    );
    const tip1 = await sh(branchRoot, ["rev-parse", refTrunk(csId)]);

    expect(
      orchestrator.ask({
        pinId: id!,
        prompt: "second",
        repoRoot: branchRoot,
        appDir: "",
      }).error,
    ).toBeUndefined();
    await until(
      () => events.filter((event) => event.type === "turn-end").length === 2,
      "second turn-end",
    );
    const tip2 = await sh(branchRoot, ["rev-parse", refTrunk(csId)]);
    expect(tip2).not.toBe(tip1);
    expect(
      events.filter((event) => event.type === "turn-start").length,
    ).toBe(2);
    // Neither turn-end carries an error and busy is released for a third.
    for (const end of events.filter((event) => event.type === "turn-end")) {
      expect(end.error).toBeUndefined();
    }
    expect(
      orchestrator.ask({
        pinId: id!,
        prompt: "third would admit",
        repoRoot: branchRoot,
        appDir: "",
      }).error,
    ).toBeUndefined();
    await until(
      () => events.filter((event) => event.type === "turn-end").length === 3,
      "third turn-end",
    );
  });
});

describe("branch topology: git-tracked pin index (shared pin ids)", () => {
  it("both homes keep their OWN copy; a branch-scoped ask runs against the branch root", async () => {
    // Seed the pin on the PRIMARY home and COMMIT the index — the branch
    // worktree's checkout then carries the same pin id (the live repos
    // track .designbook/sandbox/index.ts).
    const primarySeed = await (async () => {
      const primary = await mkdtemp(join(tmpdir(), "db-branchtopo-"));
      cleanups.push(primary);
      await mkdir(join(primary, "src"), { recursive: true });
      await writeFile(
        join(primary, "src/Card.tsx"),
        "export function ProductCard() { return null; }\n",
      );
      await execFileAsync("git", ["init", "-q", "-b", "main", primary]);
      await gitCommitAll(primary, "init");
      return primary;
    })();
    const seeding = harness(async () => ({ text: "" }));
    const created = await seeding.orchestrator.createPin({
      repoRoot: primarySeed,
      appDir: "",
      target: TARGET,
      contextSnapshot: {},
    });
    const pinId = created.id!;
    await seeding.orchestrator.settle();
    expect(existsSync(join(primarySeed, ".designbook/sandbox-index.ts"))).toBe(
      true,
    );
    await gitCommitAll(primarySeed, "track sandbox index");
    const branch = "design/x";
    const branchRoot = join(primarySeed, ".designbook/worktrees/design--x");
    await mkdir(dirname(branchRoot), { recursive: true });
    await execFileAsync(
      "git",
      ["worktree", "add", "-q", "-b", branch, branchRoot],
      { cwd: primarySeed },
    );
    // The branch moves ahead of primary, so home mixups are observable.
    await gitCommitAll(branchRoot, "branch tip moves");

    const { events, orchestrator, turnCalls } = harness(
      editTurns("export function ProductCard(){return 'branch';}\n"),
    );
    // PRIMARY revives first (the hijack precondition), then the branch.
    const primaryStatus = await orchestrator.status(primarySeed, "");
    expect(primaryStatus.pins.map((pin) => pin.id)).toEqual([pinId]);
    const branchStatus = await orchestrator.status(branchRoot, "");
    expect(branchStatus.pins.map((pin) => pin.id)).toEqual([pinId]);

    // The BRANCH page's ask must operate the BRANCH home's copy — before
    // the per-home pin map, the primary's revive claimed the id and this
    // ask ran against the primary root (refs/worktrees/events all wrong).
    expect(
      orchestrator.ask({
        pinId,
        prompt: "edit on the branch",
        repoRoot: branchRoot,
        appDir: "",
      }).error,
    ).toBeUndefined();
    await until(
      () => events.some((event) => event.type === "turn-end"),
      "turn-end",
    );
    const editCall = turnCalls.find((call) => call.mode === "edit")!;
    expect(
      editCall.cwd.startsWith(join(branchRoot, ".designbook/worktrees/")),
    ).toBe(true);
    const base = await sh(primarySeed, [
      "rev-parse",
      `refs/designbook/changesets/cs-${pinId}/base`,
    ]);
    expect(base).toBe(await sh(branchRoot, ["rev-parse", "HEAD"]));
    expect(base).not.toBe(await sh(primarySeed, ["rev-parse", "HEAD"]));
    // Ask events carry the BRANCH home.
    for (const event of events.filter((event) => event.pinId === pinId)) {
      expect(event.__home?.repoRoot).toBe(branchRoot);
    }
    // The primary home's copy is untouched (no thread bleed-through).
    const after = await orchestrator.status(primarySeed, "");
    expect(after.pins[0].thread).toEqual([]);
  });
});

describe("branch topology: stranded foreign state degrades gracefully", () => {
  it("foreign refs (another root's changesets) + orphan dirs never crash listing", async () => {
    const { primary, branchRoot } = await makeBranchTopology();
    const { orchestrator } = harness(async () => ({ text: "" }));
    // Refs exist repo-wide for a changeset whose layer dir lives in the
    // OTHER root (they share one refs store) — plus an orphan changeset dir
    // with no meta and one with a mismatched id.
    const head = await sh(primary, ["rev-parse", "HEAD"]);
    await sh(primary, [
      "update-ref",
      "refs/designbook/changesets/cs-foreign-elsewhere/base",
      head,
    ]);
    await sh(primary, [
      "update-ref",
      "refs/designbook/changesets/cs-foreign-elsewhere/trunk",
      head,
    ]);
    await mkdir(join(primary, ".designbook/changesets/cs-orphan"), {
      recursive: true,
    });
    await mkdir(join(primary, ".designbook/changesets/cs-mismatch"), {
      recursive: true,
    });
    await writeFile(
      join(primary, ".designbook/changesets/cs-mismatch/meta.json"),
      JSON.stringify({ id: "cs-other" }),
    );
    // Orphan worktree dir (not a registered git worktree).
    await mkdir(join(primary, ".designbook/worktrees/cs-gone"), {
      recursive: true,
    });

    const primaryStatus = await orchestrator.status(primary, "");
    expect(primaryStatus.changesets).toEqual([]);
    const branchStatus = await orchestrator.status(branchRoot, "");
    expect(branchStatus.changesets).toEqual([]);
    const graph = await orchestrator.historyGraph({
      repoRoot: primary,
      appDir: "",
      conversationId: "conv-none",
      turns: [],
    });
    expect(graph.error).toBeUndefined();
    expect(graph.changesets).toEqual([]);
  });
});
