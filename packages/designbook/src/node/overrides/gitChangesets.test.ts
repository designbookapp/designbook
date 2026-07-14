/**
 * Git core tests (docs/specs/changesets-on-git.md, G1) — hidden refs,
 * worktrees, per-write commit capture, trailers, plumbing commits — against
 * REAL temp git repositories. Timer-free: the idle prune takes an injected
 * clock.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitRequiredError,
  altIdOfRef,
  createGitChangesets,
  refBase,
  refSelected,
  refTrunk,
  refVariant,
  worktreePathFor,
} from "./gitChangesets.ts";

const execFileAsync = promisify(execFile);

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true }).catch(() => {});
  }
});

async function sh(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** A real git repo with one committed source file. */
async function makeGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "db-gitcs-"));
  cleanups.push(root);
  await execFileAsync("git", ["init", "-q", "-b", "main", root]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/Card.tsx"),
    "export function ProductCard() { return null; }\n",
  );
  await writeFile(join(root, ".gitignore"), "node_modules\n");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    { cwd: root },
  );
  return root;
}

describe("ref names", () => {
  it("builds hidden refs (never refs/heads) and decodes variant alt ids", () => {
    expect(refTrunk("cs-a")).toBe("refs/designbook/changesets/cs-a/trunk");
    expect(refBase("cs-a")).toBe("refs/designbook/changesets/cs-a/base");
    expect(refVariant("cs-a", "compact")).toBe(
      "refs/designbook/changesets/cs-a/v/compact",
    );
    expect(refSelected("cs-a")).toBe(
      "refs/designbook/changesets/cs-a/selected",
    );
    expect(altIdOfRef("cs-a", refVariant("cs-a", "warm"))).toBe("warm");
    expect(altIdOfRef("cs-a", refTrunk("cs-a"))).toBeUndefined();
    for (const ref of [refTrunk("x"), refBase("x"), refVariant("x", "y")]) {
      expect(ref.startsWith("refs/heads/")).toBe(false);
    }
  });
});

describe("changeset refs", () => {
  it("creates base+trunk at HEAD, idempotently, and requires git", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const head = await sh(repo, ["rev-parse", "HEAD"]);
    const first = await ops.ensureChangesetRefs(repo, "cs-a");
    expect(first).toEqual({ baseCommit: head, trunkTip: head, created: true });
    const again = await ops.ensureChangesetRefs(repo, "cs-a");
    expect(again.created).toBe(false);
    expect(again.baseCommit).toBe(head);
    // Hidden from git branch.
    expect(await sh(repo, ["branch", "--list"])).not.toContain("cs-a");

    const bare = await mkdtemp(join(tmpdir(), "db-nogit-"));
    cleanups.push(bare);
    await expect(ops.ensureChangesetRefs(bare, "cs-a")).rejects.toBeInstanceOf(
      GitRequiredError,
    );
    await expect(
      ops.ensureChangesetRefs(bare, "cs-a"),
    ).rejects.toThrowError(/require a git repository/);
  });

  it("cuts variant branches at the CURRENT trunk tip and lists refs", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const { baseCommit } = await ops.ensureChangesetRefs(repo, "cs-a");
    await ops.cutVariantBranch(repo, "cs-a", "compact");
    // Advance trunk, cut another — it must sit at the NEW tip.
    const moved = await ops.commitFileChange({
      repoRoot: repo,
      ref: refTrunk("cs-a"),
      path: "src/Card.tsx",
      content: "export function ProductCard() { return 1; }\n",
      message: "direct edit: src/Card.tsx",
    });
    await ops.cutVariantBranch(repo, "cs-a", "warm");
    expect(await ops.resolveCommit(repo, refVariant("cs-a", "compact"))).toBe(
      baseCommit,
    );
    expect(await ops.resolveCommit(repo, refVariant("cs-a", "warm"))).toBe(
      moved,
    );
    const refs = (await ops.listRefs(repo, "cs-a")).map((entry) => entry.ref);
    expect(refs).toEqual([
      refBase("cs-a"),
      refTrunk("cs-a"),
      refVariant("cs-a", "compact"),
      refVariant("cs-a", "warm"),
    ]);
  });

  it("selection pointer: set, read, clear, and delete-all cleanup", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    await ops.ensureChangesetRefs(repo, "cs-a");
    await ops.cutVariantBranch(repo, "cs-a", "compact");
    await ops.setSelected(repo, "cs-a", refVariant("cs-a", "compact"));
    expect(await ops.getSelected(repo, "cs-a")).toBe(
      refVariant("cs-a", "compact"),
    );
    await ops.setSelected(repo, "cs-a", null);
    expect(await ops.getSelected(repo, "cs-a")).toBeUndefined();
    await ops.setSelected(repo, "cs-a", refTrunk("cs-a"));
    await ops.deleteChangesetRefs(repo, "cs-a");
    expect(await ops.listRefs(repo, "cs-a")).toEqual([]);
    // Deleting the selected symref must NOT have deleted its target first —
    // trunk was removed by the sweep, not through the symref.
    expect(await ops.getSelected(repo, "cs-a")).toBeUndefined();
    expect(await sh(repo, ["for-each-ref", "refs/designbook"])).toBe("");
  });
});

describe("worktrees", () => {
  it("creates lazily, attaches HEAD to the hidden ref, symlinks node_modules, reuses", async () => {
    const repo = await makeGitRepo();
    await mkdir(join(repo, "node_modules/dep"), { recursive: true });
    const ops = createGitChangesets();
    await ops.ensureChangesetRefs(repo, "cs-a");
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refTrunk("cs-a"),
      appDir: "",
    });
    expect(worktree).toBe(worktreePathFor(repo, "cs-a"));
    expect(await sh(worktree, ["symbolic-ref", "HEAD"])).toBe(refTrunk("cs-a"));
    expect((await lstat(join(worktree, "node_modules"))).isSymbolicLink()).toBe(
      true,
    );
    // The worktrees dir is excluded from the user's git surfaces.
    const exclude = await readFile(
      join(repo, ".git/info/exclude"),
      "utf8",
    );
    expect(exclude).toContain("**/.designbook/worktrees/");
    // Reuse: same path, no error; commit advances the hidden ref.
    const again = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refTrunk("cs-a"),
      appDir: "",
    });
    expect(again).toBe(worktree);
    await writeFile(join(worktree, "src/Card.tsx"), "changed\n");
    const sha = await ops.commitAll(worktree, "write: src/Card.tsx");
    expect(sha).toBeTruthy();
    expect(await ops.resolveCommit(repo, refTrunk("cs-a"))).toBe(sha);
    // Still invisible: no branch, and worktree list shows a non-heads ref.
    expect(await sh(repo, ["branch", "--list"])).not.toContain("cs-a");
    expect(await sh(repo, ["worktree", "list", "--porcelain"])).toContain(
      `branch ${refTrunk("cs-a")}`,
    );
  });

  it("selection = checkout: attach flips branches and discards strays", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    await ops.ensureChangesetRefs(repo, "cs-a");
    await ops.cutVariantBranch(repo, "cs-a", "compact");
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refVariant("cs-a", "compact"),
      appDir: "",
    });
    await writeFile(join(worktree, "src/Card.tsx"), "compact design\n");
    await ops.commitAll(worktree, "write: src/Card.tsx");
    // Switch back to trunk: the file reverts; an uncommitted stray drops.
    await writeFile(join(worktree, "stray.txt"), "stray\n");
    await ops.attachWorktree(worktree, refTrunk("cs-a"));
    expect(await readFile(join(worktree, "src/Card.tsx"), "utf8")).toContain(
      "ProductCard",
    );
    expect(existsSync(join(worktree, "stray.txt"))).toBe(false);
    // And forward again: the variant's design comes back.
    await ops.attachWorktree(worktree, refVariant("cs-a", "compact"));
    expect(await readFile(join(worktree, "src/Card.tsx"), "utf8")).toBe(
      "compact design\n",
    );
  });

  it("prunes idle worktrees on the injected clock; discard removes traces", async () => {
    const repo = await makeGitRepo();
    let clock = 1_000_000;
    const ops = createGitChangesets({
      now: () => clock,
      worktreeIdleMs: 10_000,
    });
    await ops.ensureChangesetRefs(repo, "cs-a");
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refTrunk("cs-a"),
      appDir: "",
    });
    // Fresh — not pruned.
    expect(await ops.pruneIdleWorktrees(repo)).toEqual([]);
    expect(existsSync(worktree)).toBe(true);
    // Past the idle threshold — pruned, git admin record included.
    clock += 10_001;
    expect(await ops.pruneIdleWorktrees(repo)).toEqual([worktree]);
    expect(existsSync(worktree)).toBe(false);
    // Assert on the worktree PATH, not the bare id — the random tmp-repo
    // suffix can spell "cs-a" by chance ("db-gitcs-a…", live flake).
    expect(await sh(repo, ["worktree", "list", "--porcelain"])).not.toContain(
      worktree,
    );
    // Recreate then discard: removeWorktree + deleteChangesetRefs leaves
    // NOTHING visible in any git surface.
    await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refTrunk("cs-a"),
      appDir: "",
    });
    await ops.removeWorktree(repo, "cs-a");
    await ops.deleteChangesetRefs(repo, "cs-a");
    expect(existsSync(worktreePathFor(repo, "cs-a"))).toBe(false);
    expect(await sh(repo, ["for-each-ref", "refs/designbook"])).toBe("");
    expect(await sh(repo, ["worktree", "list", "--porcelain"])).not.toContain(
      worktreePathFor(repo, "cs-a"),
    );
  });

  it("temp worktrees serve one fan-out arm and remove cleanly", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    await ops.ensureChangesetRefs(repo, "cs-a");
    await ops.cutVariantBranch(repo, "cs-a", "warm");
    const temp = await ops.createTempWorktree({
      repoRoot: repo,
      ref: refVariant("cs-a", "warm"),
      appDir: "",
    });
    cleanups.push(temp);
    expect(await sh(temp, ["symbolic-ref", "HEAD"])).toBe(
      refVariant("cs-a", "warm"),
    );
    await writeFile(join(temp, "src/Card.tsx"), "warm design\n");
    await ops.commitAll(temp, "write: src/Card.tsx");
    expect(
      await ops.readBlob(repo, refVariant("cs-a", "warm"), "src/Card.tsx"),
    ).toBe("warm design\n");
    await ops.removeTempWorktree(repo, temp);
    expect(existsSync(temp)).toBe(false);
  });
});

describe("turn capture", () => {
  it("commits per tool-write with Designbook-Tool-Call, stamps turn trailers, reports the range", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const { trunkTip } = await ops.ensureChangesetRefs(repo, "cs-a");
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refTrunk("cs-a"),
      appDir: "",
    });
    const capture = ops.createTurnCapture({
      repoRoot: repo,
      worktreeAbs: worktree,
      ref: refTrunk("cs-a"),
      startTip: trunkTip,
    });
    // Tool 1 writes, tool 2 is a read (no commit), tool 3 writes two files.
    await writeFile(join(worktree, "src/Card.tsx"), "v1\n");
    await capture.noteToolEnd({ toolCallId: "call-1", toolName: "write" });
    await capture.noteToolEnd({ toolCallId: "call-2", toolName: "read" });
    await writeFile(join(worktree, "src/Extra.tsx"), "extra\n");
    await writeFile(join(worktree, "src/Card.tsx"), "v2\n");
    await capture.noteToolEnd({ toolCallId: "call-3", toolName: "edit" });
    const range = await capture.finish({
      conversationId: "c-1",
      sessionId: "sess-1",
      turnIndex: 3,
    });
    expect(range.from).toBe(trunkTip);
    expect(range.commits).toHaveLength(2);
    expect(await ops.resolveCommit(repo, refTrunk("cs-a"))).toBe(range.to);

    const first = await ops.commitInfo(repo, range.commits[0]);
    expect(first.subject).toBe("write: src/Card.tsx");
    expect(first.trailers["Designbook-Tool-Call"]).toBe("call-1");
    const last = await ops.commitInfo(repo, range.commits[1]);
    expect(last.subject).toContain("edit: ");
    expect(last.trailers["Designbook-Tool-Call"]).toBe("call-3");
    // Turn boundary trailers land on the FINAL commit only.
    expect(last.trailers["Designbook-Conversation"]).toBe("c-1");
    expect(last.trailers["Designbook-Turn"]).toBe("sess-1/3");
    expect(first.trailers["Designbook-Conversation"]).toBeUndefined();
  });

  it("catch-all commits un-noted writes at finish; clean turns report an empty range", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const { trunkTip } = await ops.ensureChangesetRefs(repo, "cs-a");
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refTrunk("cs-a"),
      appDir: "",
    });
    // Clean turn.
    const clean = await ops
      .createTurnCapture({
        repoRoot: repo,
        worktreeAbs: worktree,
        ref: refTrunk("cs-a"),
        startTip: trunkTip,
      })
      .finish({ sessionId: "s" });
    expect(clean.commits).toEqual([]);
    expect(clean.from).toBe(clean.to);
    // A bash-style write nobody noted still lands via the finish catch-all.
    await writeFile(join(worktree, "src/FromBash.tsx"), "bash wrote this\n");
    const range = await ops
      .createTurnCapture({
        repoRoot: repo,
        worktreeAbs: worktree,
        ref: refTrunk("cs-a"),
        startTip: trunkTip,
      })
      .finish({ conversationId: "c-9", sessionId: "s-9" });
    expect(range.commits).toHaveLength(1);
    const info = await ops.commitInfo(repo, range.commits[0]);
    expect(info.subject).toContain("turn writes: src/FromBash.tsx");
    expect(info.trailers["Designbook-Conversation"]).toBe("c-9");
  });

  it("never commits the node_modules symlinks (dir-only ignore patterns miss symlinks)", async () => {
    const repo = await makeGitRepo();
    await mkdir(join(repo, "node_modules/dep"), { recursive: true });
    const ops = createGitChangesets();
    const { trunkTip } = await ops.ensureChangesetRefs(repo, "cs-a");
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refTrunk("cs-a"),
      appDir: "",
    });
    // The symlink exists and SURVIVES attach (clean -e node_modules)…
    expect((await lstat(join(worktree, "node_modules"))).isSymbolicLink()).toBe(
      true,
    );
    await ops.attachWorktree(worktree, refTrunk("cs-a"));
    expect((await lstat(join(worktree, "node_modules"))).isSymbolicLink()).toBe(
      true,
    );
    // …and never becomes a commit, alone or alongside real writes.
    expect(await ops.commitAll(worktree, "noop")).toBeUndefined();
    await writeFile(join(worktree, "src/Card.tsx"), "real change\n");
    const capture = ops.createTurnCapture({
      repoRoot: repo,
      worktreeAbs: worktree,
      ref: refTrunk("cs-a"),
      startTip: trunkTip,
    });
    await capture.noteToolEnd({ toolCallId: "c", toolName: "write" });
    const range = await capture.finish({});
    expect(range.commits).toHaveLength(1);
    const info = await ops.commitInfo(repo, range.commits[0]);
    expect(info.subject).toBe("write: src/Card.tsx");
    const changed = await ops.changedFiles(repo, range.from, range.to);
    expect(changed.map((c) => c.path)).toEqual(["src/Card.tsx"]);
  });

  it("caps the files summary and ignores gitignored writes", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const { trunkTip } = await ops.ensureChangesetRefs(repo, "cs-a");
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refTrunk("cs-a"),
      appDir: "",
    });
    for (let i = 0; i < 6; i += 1) {
      await writeFile(join(worktree, `src/f${i}.ts`), `${i}\n`);
    }
    const capture = ops.createTurnCapture({
      repoRoot: repo,
      worktreeAbs: worktree,
      ref: refTrunk("cs-a"),
      startTip: trunkTip,
    });
    await capture.noteToolEnd({ toolCallId: "c", toolName: "bash" });
    const range = await capture.finish({});
    const info = await ops.commitInfo(repo, range.commits[0]);
    expect(info.subject).toContain("(+2 more)");
    // Ignored-only writes never produce a commit.
    await mkdir(join(worktree, "node_modules"), { recursive: true });
    await writeFile(join(worktree, "node_modules/x.js"), "ignored\n");
    const capture2 = ops.createTurnCapture({
      repoRoot: repo,
      worktreeAbs: worktree,
      ref: refTrunk("cs-a"),
      startTip: range.to,
    });
    await capture2.noteToolEnd({ toolCallId: "c2", toolName: "write" });
    const range2 = await capture2.finish({});
    expect(range2.commits).toEqual([]);
  });
});

describe("plumbing + queries", () => {
  it("commitFileChange lands one file on a ref without any worktree", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    await ops.ensureChangesetRefs(repo, "cs-a");
    const commit = await ops.commitFileChange({
      repoRoot: repo,
      ref: refTrunk("cs-a"),
      path: "locales/en.json",
      content: '{"hello":"world"}\n',
      message: "direct edit: locales/en.json",
      trailers: ["Designbook-Conversation: c-2"],
    });
    expect(await ops.resolveCommit(repo, refTrunk("cs-a"))).toBe(commit);
    expect(await ops.readBlob(repo, commit, "locales/en.json")).toBe(
      '{"hello":"world"}\n',
    );
    // The user's checkout + index are untouched.
    expect(existsSync(join(repo, "locales/en.json"))).toBe(false);
    expect(await sh(repo, ["status", "--porcelain"])).toBe("");
    const info = await ops.commitInfo(repo, commit);
    expect(info.trailers["Designbook-Conversation"]).toBe("c-2");
  });

  it("changedFiles + readBlob + isAncestor answer the projection's questions", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const { baseCommit } = await ops.ensureChangesetRefs(repo, "cs-a");
    const tip = await ops.commitFileChange({
      repoRoot: repo,
      ref: refTrunk("cs-a"),
      path: "src/New.tsx",
      content: "new module\n",
      message: "write: src/New.tsx",
    });
    const changed = await ops.changedFiles(repo, baseCommit, tip);
    expect(changed).toEqual([{ status: "A", path: "src/New.tsx" }]);
    expect(await ops.readBlob(repo, baseCommit, "src/New.tsx")).toBeUndefined();
    expect(await ops.readBlob(repo, tip, "src/Card.tsx")).toContain(
      "ProductCard",
    );
    expect(await ops.isAncestor(repo, baseCommit, tip)).toBe(true);
    expect(await ops.isAncestor(repo, tip, baseCommit)).toBe(false);
  });

  it("rollback primitive: update-ref rewinds, reflog keeps the rolled-off commit", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const { trunkTip } = await ops.ensureChangesetRefs(repo, "cs-a");
    const c1 = await ops.commitFileChange({
      repoRoot: repo,
      ref: refTrunk("cs-a"),
      path: "src/Card.tsx",
      content: "turn 1\n",
      message: "write: src/Card.tsx",
    });
    const c2 = await ops.commitFileChange({
      repoRoot: repo,
      ref: refTrunk("cs-a"),
      path: "src/Card.tsx",
      content: "turn 2\n",
      message: "write: src/Card.tsx",
    });
    expect(await ops.commitsInRange(repo, trunkTip, c2)).toEqual([c1, c2]);
    await ops.updateRef(repo, refTrunk("cs-a"), c1);
    expect(await ops.resolveCommit(repo, refTrunk("cs-a"))).toBe(c1);
    // The rolled-off commit object is still reachable by sha (until gc).
    expect(await ops.readBlob(repo, c2, "src/Card.tsx")).toBe("turn 2\n");
  });
});

// ---------------------------------------------------------------------------
// G2: turn diffs + the reapply cherry-pick seams.
// ---------------------------------------------------------------------------

describe("diffRange (turn-diff)", () => {
  it("produces a unified diff for a commit range and caps oversized output at a line boundary", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const { trunkTip } = await ops.ensureChangesetRefs(repo, "cs-a");
    const tip = await ops.commitFileChange({
      repoRoot: repo,
      ref: refTrunk("cs-a"),
      path: "src/Card.tsx",
      content: "export function ProductCard() { return <b>bold</b>; }\n",
      message: "edit: src/Card.tsx",
    });
    const full = await ops.diffRange(repo, trunkTip, tip);
    expect(full.truncated).toBe(false);
    expect(full.diff).toContain("--- a/src/Card.tsx");
    expect(full.diff).toContain("+++ b/src/Card.tsx");
    expect(full.diff).toContain("+export function ProductCard() { return <b>bold</b>; }");
    // Same commit on both sides = empty diff.
    expect(await ops.diffRange(repo, tip, tip)).toEqual({
      diff: "",
      truncated: false,
    });
    // A tiny cap truncates at the last complete line and flags it.
    const capped = await ops.diffRange(repo, trunkTip, tip, { maxBytes: 64 });
    expect(capped.truncated).toBe(true);
    expect(capped.diff.length).toBeLessThanOrEqual(64);
    expect(capped.diff.endsWith("\n")).toBe(true);
  });
});

describe("cherryPickRange (reapply)", () => {
  /** Two variant branches off one trunk + edits on branch A past its cut. */
  async function reapplyFixture() {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    await ops.ensureChangesetRefs(repo, "cs-a");
    await ops.cutVariantBranch(repo, "cs-a", "va");
    await ops.cutVariantBranch(repo, "cs-a", "vb");
    // Distinct generation commits per branch.
    const genA = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant("cs-a", "va"),
      path: "src/Card.tsx",
      content: "variant A\n",
      message: "variant: va",
    }))!;
    await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant("cs-a", "vb"),
      path: "src/Card.tsx",
      content: "variant B\n",
      message: "variant: vb",
    });
    return { repo, ops, genA };
  }

  it("clean: post-selection commits land on the target branch; the source branch keeps them", async () => {
    const { repo, ops, genA } = await reapplyFixture();
    // A post-selection edit on A touching a DIFFERENT file (no conflict).
    const editA = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant("cs-a", "va"),
      path: "src/Extra.tsx",
      content: "extra edit\n",
      message: "edit: src/Extra.tsx",
    }))!;
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refVariant("cs-a", "vb"),
      appDir: "",
    });
    const result = await ops.cherryPickRange(worktree, genA, editA);
    expect(result.status).toBe("clean");
    const tipB = (await ops.resolveCommit(repo, refVariant("cs-a", "vb")))!;
    expect(await ops.readBlob(repo, tipB, "src/Extra.tsx")).toBe("extra edit\n");
    // B kept its own design; A kept its edit.
    expect(await ops.readBlob(repo, tipB, "src/Card.tsx")).toBe("variant B\n");
    const tipA = (await ops.resolveCommit(repo, refVariant("cs-a", "va")))!;
    expect(await ops.readBlob(repo, tipA, "src/Extra.tsx")).toBe("extra edit\n");
  });

  it("conflict: pauses with markers; continueCherryPick finishes a staged resolution", async () => {
    const { repo, ops, genA } = await reapplyFixture();
    // A post-selection edit on A touching the SAME file both variants rewrote.
    const editA = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant("cs-a", "va"),
      path: "src/Card.tsx",
      content: "variant A, edited\n",
      message: "edit: src/Card.tsx",
    }))!;
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refVariant("cs-a", "vb"),
      appDir: "",
    });
    const before = (await ops.resolveCommit(repo, refVariant("cs-a", "vb")))!;
    const result = await ops.cherryPickRange(worktree, genA, editA);
    expect(result.status).toBe("conflict");
    expect(await ops.cherryPickInProgress(worktree)).toBe(true);
    expect(await readFile(join(worktree, "src/Card.tsx"), "utf8")).toContain(
      "<<<<<<<",
    );
    // "Merge turn": resolve preserving both intents, then continue.
    await writeFile(join(worktree, "src/Card.tsx"), "variant B, edited\n");
    expect(await ops.continueCherryPick(worktree)).toBe(true);
    expect(await ops.cherryPickInProgress(worktree)).toBe(false);
    const tipB = (await ops.resolveCommit(repo, refVariant("cs-a", "vb")))!;
    expect(tipB).not.toBe(before);
    expect(await ops.readBlob(repo, tipB, "src/Card.tsx")).toBe(
      "variant B, edited\n",
    );
  });

  it("abort: abortCherryPick restores the branch tip and a clean tree", async () => {
    const { repo, ops, genA } = await reapplyFixture();
    const editA = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant("cs-a", "va"),
      path: "src/Card.tsx",
      content: "variant A, edited again\n",
      message: "edit: src/Card.tsx",
    }))!;
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refVariant("cs-a", "vb"),
      appDir: "",
    });
    const before = (await ops.resolveCommit(repo, refVariant("cs-a", "vb")))!;
    const result = await ops.cherryPickRange(worktree, genA, editA);
    expect(result.status).toBe("conflict");
    await ops.abortCherryPick(worktree);
    expect(await ops.cherryPickInProgress(worktree)).toBe(false);
    expect(await ops.resolveCommit(repo, refVariant("cs-a", "vb"))).toBe(before);
    expect(await ops.dirtyPaths(worktree)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// G3: rebase seams + squashed-diff apply + branch plumbing.
// ---------------------------------------------------------------------------

describe("snapshotBaseCommit (rebase base)", () => {
  it("returns HEAD when the tracked paths match; otherwise a synthetic child of HEAD", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const head = await sh(repo, ["rev-parse", "HEAD"]);
    expect(await ops.snapshotBaseCommit(repo, ["src/Card.tsx"])).toBe(head);
    // Dirty (uncommitted) content on a tracked path → synthetic commit,
    // parented on HEAD, carrying the on-disk content. User surfaces untouched.
    await writeFile(
      join(repo, "src/Card.tsx"),
      "export function ProductCard() { return 'dirty'; }\n",
    );
    const snap = await ops.snapshotBaseCommit(repo, ["src/Card.tsx"]);
    expect(snap).not.toBe(head);
    expect(await sh(repo, ["rev-parse", `${snap}^`])).toBe(head);
    expect(await ops.readBlob(repo, snap, "src/Card.tsx")).toContain("dirty");
    expect(await sh(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(await sh(repo, ["diff", "--cached", "--name-only"])).toBe("");
  });
});

describe("rebaseOnto / continueRebase / abortRebase", () => {
  /** Trunk with one commit off base + an out-of-band base move. */
  async function rebaseFixture(params: { conflicting: boolean }) {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const { baseCommit } = await ops.ensureChangesetRefs(repo, "cs-a");
    // The changeset design commit: rewrite line 1 (conflicting) or add a
    // separate file (clean).
    const tip = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refTrunk("cs-a"),
      path: params.conflicting ? "src/Card.tsx" : "src/Design.tsx",
      content: params.conflicting
        ? "export function ProductCard() { return 'design'; }\n"
        : "design module\n",
      message: "variant: design",
    }))!;
    // Out-of-band source move AFTER capture (a committed drift).
    await writeFile(
      join(repo, "src/Card.tsx"),
      params.conflicting
        ? "export function ProductCard() { return 'outside'; }\n"
        : "// outside change\nexport function ProductCard() { return null; }\n",
    );
    await execFileAsync("git", ["add", "-A"], { cwd: repo });
    await execFileAsync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "outside"],
      { cwd: repo },
    );
    const newBase = await ops.snapshotBaseCommit(repo, ["src/Card.tsx"]);
    const worktree = await ops.ensureWorktree({
      repoRoot: repo,
      changesetId: "cs-a",
      ref: refTrunk("cs-a"),
      appDir: "",
    });
    return { repo, ops, baseCommit, tip, newBase, worktree };
  }

  it("clean: replays the branch onto the new base; both changes present; commit count preserved", async () => {
    const { repo, ops, baseCommit, tip, newBase, worktree } =
      await rebaseFixture({ conflicting: false });
    const result = await ops.rebaseOnto(worktree, {
      onto: newBase,
      upstream: baseCommit,
      tip,
    });
    expect(result.status).toBe("clean");
    const newTip = (result as { newTip: string }).newTip;
    await ops.updateRef(repo, refTrunk("cs-a"), newTip);
    expect(await ops.readBlob(repo, newTip, "src/Design.tsx")).toBe(
      "design module\n",
    );
    expect(await ops.readBlob(repo, newTip, "src/Card.tsx")).toContain(
      "outside change",
    );
    // Distance-based baselines stay valid: one commit off the new base.
    expect(await ops.commitsInRange(repo, newBase, newTip)).toHaveLength(1);
    expect(await sh(repo, ["rev-parse", `${newTip}~1`])).toBe(newBase);
  });

  it("conflict: pauses with markers; continueRebase finishes a resolution and refuses unresolved ones", async () => {
    const { ops, baseCommit, tip, newBase, worktree } = await rebaseFixture({
      conflicting: true,
    });
    const result = await ops.rebaseOnto(worktree, {
      onto: newBase,
      upstream: baseCommit,
      tip,
    });
    expect(result.status).toBe("conflict");
    expect(await ops.rebaseInProgress(worktree)).toBe(true);
    expect(await readFile(join(worktree, "src/Card.tsx"), "utf8")).toContain(
      "<<<<<<<",
    );
    // Unresolved markers must never continue.
    expect(await ops.continueRebase(worktree)).toBe(false);
    // "Merge turn": resolve preserving both intents, then continue.
    await writeFile(
      join(worktree, "src/Card.tsx"),
      "export function ProductCard() { return 'design+outside'; }\n",
    );
    expect(await ops.continueRebase(worktree)).toBe(true);
    expect(await ops.rebaseInProgress(worktree)).toBe(false);
    const newTip = (await ops.resolveCommit(worktree, "HEAD"))!;
    expect(await ops.readBlob(worktree, newTip, "src/Card.tsx")).toContain(
      "design+outside",
    );
  });

  it("abort: abortRebase restores a clean tree and the branch ref never moved", async () => {
    const { repo, ops, baseCommit, tip, newBase, worktree } =
      await rebaseFixture({ conflicting: true });
    const result = await ops.rebaseOnto(worktree, {
      onto: newBase,
      upstream: baseCommit,
      tip,
    });
    expect(result.status).toBe("conflict");
    await ops.abortRebase(worktree);
    expect(await ops.rebaseInProgress(worktree)).toBe(false);
    expect(await ops.dirtyPaths(worktree)).toEqual([]);
    expect(await ops.resolveCommit(repo, refTrunk("cs-a"))).toBe(tip);
  });
});

describe("diffPatch + applyPatch3Way (bake via merge)", () => {
  it("clean apply onto a DIRTY working tree: unrelated dirt survives, index untouched", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs/notes.md"), "committed\n");
    await execFileAsync("git", ["add", "-A"], { cwd: repo });
    await execFileAsync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "docs"],
      { cwd: repo },
    );
    const { baseCommit } = await ops.ensureChangesetRefs(repo, "cs-a");
    const tip = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refTrunk("cs-a"),
      path: "src/Card.tsx",
      content: "export function ProductCard() { return 'baked'; }\n",
      message: "design",
    }))!;
    // Unrelated dirt in the user's tree.
    await writeFile(join(repo, "docs/notes.md"), "user dirt\n");
    const patch = await ops.diffPatch(repo, baseCommit, tip, ["src/Card.tsx"]);
    expect(patch).toContain("src/Card.tsx");
    const applied = await ops.applyPatch3Way(repo, patch, ["src/Card.tsx"]);
    expect(applied.status).toBe("clean");
    expect(await readFile(join(repo, "src/Card.tsx"), "utf8")).toContain(
      "baked",
    );
    expect(await readFile(join(repo, "docs/notes.md"), "utf8")).toBe(
      "user dirt\n",
    );
    // The user's REAL index gained nothing (temp-index apply).
    expect(await sh(repo, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("3-way merges drift on OTHER lines; overlapping edits report conflict files with markers", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    // Enough padding between the drift line and the design line that the
    // 3-way merge regions never touch.
    const pad = "// p1\n// p2\n// p3\n// p4\n// p5\n";
    const original = `// header\n${pad}export function ProductCard() { return null; }\n${pad}// footer\n`;
    await writeFile(join(repo, "src/Card.tsx"), original);
    await execFileAsync("git", ["add", "-A"], { cwd: repo });
    await execFileAsync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "padded"],
      { cwd: repo },
    );
    const { baseCommit } = await ops.ensureChangesetRefs(repo, "cs-a");
    const tip = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refTrunk("cs-a"),
      path: "src/Card.tsx",
      content: original.replace("return null", "return 'design'"),
      message: "design",
    }))!;
    // Non-overlapping dirty drift (header line) → clean 3-way, both present.
    await writeFile(
      join(repo, "src/Card.tsx"),
      original.replace("// header", "// header EDITED"),
    );
    const patch = await ops.diffPatch(repo, baseCommit, tip, ["src/Card.tsx"]);
    const merged = await ops.applyPatch3Way(repo, patch, ["src/Card.tsx"]);
    expect(merged.status).toBe("clean");
    const content = await readFile(join(repo, "src/Card.tsx"), "utf8");
    expect(content).toContain("header EDITED");
    expect(content).toContain("'design'");
    // Overlapping drift (same line) → conflict, markers in the file.
    await writeFile(
      join(repo, "src/Card.tsx"),
      original.replace("return null", "return 'outside'"),
    );
    const conflicted = await ops.applyPatch3Way(repo, patch, ["src/Card.tsx"]);
    expect(conflicted.status).toBe("conflict");
    expect((conflicted as { files: string[] }).files).toEqual(["src/Card.tsx"]);
    expect(await readFile(join(repo, "src/Card.tsx"), "utf8")).toContain(
      "<<<<<<<",
    );
  });
});

describe("bake-to-branch plumbing", () => {
  it("detached temp worktree + commitAll(preferUserIdent) + commitTreeOnto + branch ref", async () => {
    const repo = await makeGitRepo();
    const ops = createGitChangesets();
    const head = await sh(repo, ["rev-parse", "HEAD"]);
    const worktree = await ops.createDetachedTempWorktree({
      repoRoot: repo,
      commit: head,
      appDir: "",
    });
    cleanups.push(worktree);
    await writeFile(join(worktree, "src/Card.tsx"), "branch bake design\n");
    const commit = (await ops.commitAll(worktree, "designbook: bake", [], {
      preferUserIdent: true,
    }))!;
    expect(commit).toBeTruthy();
    expect(await sh(repo, ["rev-parse", `${commit}^`])).toBe(head);
    await ops.removeTempWorktree(repo, worktree);
    // First bake: the branch ref points at the materialized commit.
    expect(await ops.isValidBranchName(repo, "designbook/test-cs")).toBe(true);
    expect(await ops.isValidBranchName(repo, "bad..name")).toBe(false);
    expect(await ops.isValidBranchName(repo, "-bad")).toBe(false);
    await ops.updateRef(repo, "refs/heads/designbook/test-cs", commit);
    expect(await sh(repo, ["branch", "--list", "designbook/*"])).toContain(
      "designbook/test-cs",
    );
    // Re-bake: same tree, NEW commit parented on the branch tip.
    const rebake = await ops.commitTreeOnto({
      repoRoot: repo,
      tree: await ops.treeOf(repo, commit),
      parent: commit,
      message: "designbook: re-bake",
    });
    await ops.updateRef(repo, "refs/heads/designbook/test-cs", rebake);
    expect(await sh(repo, ["rev-parse", `${rebake}^`])).toBe(commit);
    expect(await ops.readBlob(repo, rebake, "src/Card.tsx")).toBe(
      "branch bake design\n",
    );
    // The user's checkout stayed put.
    expect(await readFile(join(repo, "src/Card.tsx"), "utf8")).toContain(
      "ProductCard",
    );
    expect(await sh(repo, ["rev-parse", "HEAD"])).toBe(head);
  });
});
