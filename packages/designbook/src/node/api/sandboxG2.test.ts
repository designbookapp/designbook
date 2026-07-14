/**
 * G2 server surfaces (docs/specs/changesets-on-git.md §G2):
 *
 *   - turnDiff: a turn's commit-range unified diff + per-tool-write commit
 *     list, ancestry-guarded against the changeset base;
 *   - reapply (spec §Selection): cherry-pick post-selection edits onto the
 *     newly selected branch — clean, conflict→ONE merge turn (injectable
 *     runner), and total-failure→abort (edits stay on the old branch);
 *   - switchSelect surfacing `reapply-available` when the previously
 *     selected branch has commits past its generation baseline (and staying
 *     silent without a baseline — pre-G2 layers never prompt).
 *
 * Orchestrator against REAL temp git repos, FAKE turns (sandbox.test.ts
 * pattern — no Pi SDK, no auth). Git state is seeded straight through the
 * git core + a hand-written layer meta, so no variant pipeline runs here.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReapplyConflictPrompt,
  createSandboxOrchestrator,
  type SandboxRunTurn,
} from "./sandbox.ts";
import {
  createGitChangesets,
  refTrunk,
  refVariant,
} from "../overrides/gitChangesets.ts";
import {
  altFilePath,
  changesetMetaPath,
  serializeLayerMeta,
  type ChangesetLayer,
} from "../overrides/layerStore.ts";

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

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "db-g2-"));
  cleanups.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/Card.tsx"),
    "export function ProductCard() { return null; }\n",
  );
  await execFileAsync("git", ["init", "-q", "-b", "main", root]);
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    { cwd: root },
  );
  return root;
}

type Emitted = { type?: string; [key: string]: unknown };

function harness(runTurn?: SandboxRunTurn) {
  const events: Emitted[] = [];
  const turnCalls: Array<Parameters<SandboxRunTurn>[0]> = [];
  const orchestrator = createSandboxOrchestrator({
    runTurn: async (params) => {
      turnCalls.push(params);
      return runTurn ? runTurn(params) : { text: "" };
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

const CS = "cs-g2";
const CARD = "src/Card.tsx";
const EXTRA = "src/Extra.tsx";

/**
 * Seed the G2 fixture directly through the git core: changeset refs, two
 * variant branches with distinct generation commits, and a persisted layer
 * meta whose `generatedTips` mark those generations (what the fan-out
 * records live).
 */
async function seedChangeset(repo: string) {
  const ops = createGitChangesets();
  const refs = await ops.ensureChangesetRefs(repo, CS);
  await ops.cutVariantBranch(repo, CS, "va");
  await ops.cutVariantBranch(repo, CS, "vb");
  const genA = (await ops.commitFileChange({
    repoRoot: repo,
    ref: refVariant(CS, "va"),
    path: CARD,
    content: "export function ProductCard() { return 'variant A'; }\n",
    message: "variant: va",
  }))!;
  const genB = (await ops.commitFileChange({
    repoRoot: repo,
    ref: refVariant(CS, "vb"),
    path: CARD,
    content: "export function ProductCard() { return 'variant B'; }\n",
    message: "variant: vb",
  }))!;
  const meta: ChangesetLayer = {
    id: CS,
    pinId: "pin-g2",
    branch: "main",
    baseCommit: refs.baseCommit,
    createdAt: 1,
    active: true,
    order: 1,
    baseHashes: {},
    overrides: { [CARD]: { selection: "va", alternatives: ["va", "vb"] } },
    generatedTips: { va: genA, vb: genB },
  };
  const metaAbs = join(repo, changesetMetaPath("", CS));
  await mkdir(join(metaAbs, ".."), { recursive: true });
  await writeFile(metaAbs, serializeLayerMeta(meta));
  await ops.setSelected(repo, CS, refVariant(CS, "va"));
  return { ops, base: refs.baseCommit, genA, genB };
}

// ---------------------------------------------------------------------------
// turnDiff.
// ---------------------------------------------------------------------------

describe("turnDiff", () => {
  it("returns the range's unified diff + per-tool-write commits with trailers", async () => {
    const repo = await makeRepo();
    const { ops, genA } = await seedChangeset(repo);
    const edit = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant(CS, "va"),
      path: EXTRA,
      content: "export const extra = 1;\n",
      message: "write: src/Extra.tsx",
      trailers: ["Designbook-Tool-Call: tc-77"],
    }))!;
    const { orchestrator } = harness();
    const result = await orchestrator.turnDiff({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      from: genA,
      to: edit,
    });
    expect(result.error).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.diff).toContain("+++ b/src/Extra.tsx");
    expect(result.diff).toContain("+export const extra = 1;");
    expect(result.commits).toEqual([
      { commit: edit, subject: "write: src/Extra.tsx", toolCall: "tc-77" },
    ]);
  });

  it("guards: unknown changeset, unresolvable shas, commits outside the changeset", async () => {
    const repo = await makeRepo();
    const { genA } = await seedChangeset(repo);
    const { orchestrator } = harness();
    expect(
      (
        await orchestrator.turnDiff({
          repoRoot: repo,
          appDir: "",
          changesetId: "nope",
          from: genA,
          to: genA,
        })
      ).error,
    ).toBeDefined();
    const gone = await orchestrator.turnDiff({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      from: "0123456789012345678901234567890123456789",
      to: genA,
    });
    expect(gone.status).toBe(410);
  });
});

// ---------------------------------------------------------------------------
// reapply.
// ---------------------------------------------------------------------------

describe("reapply", () => {
  it("clean: post-selection edits cherry-pick onto the new selection, re-project, and stay on the old branch too", async () => {
    const repo = await makeRepo();
    const { ops, genA } = await seedChangeset(repo);
    // A post-selection edit on va touching a DIFFERENT file.
    const edit = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant(CS, "va"),
      path: EXTRA,
      content: "export const extra = 'edited';\n",
      message: "edit: extra",
    }))!;
    expect(edit).not.toBe(genA);
    // The user switched selection to vb.
    await ops.setSelected(repo, CS, refVariant(CS, "vb"));

    const { events, orchestrator, turnCalls } = harness();
    const result = await orchestrator.reapply({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      fromRef: refVariant(CS, "va"),
    });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);
    expect(turnCalls).toHaveLength(0); // no conflict → no merge turn
    const tipB = (await ops.resolveCommit(repo, refVariant(CS, "vb")))!;
    expect(await ops.readBlob(repo, tipB, EXTRA)).toContain("edited");
    expect(await ops.readBlob(repo, tipB, CARD)).toContain("variant B");
    // The old branch keeps its edit (cherry-pick copies, never moves).
    const tipA = (await ops.resolveCommit(repo, refVariant(CS, "va")))!;
    expect(await ops.readBlob(repo, tipA, EXTRA)).toContain("edited");
    // Projection refreshed: the vb alternative now carries the new file.
    expect(
      existsSync(join(repo, altFilePath("", CS, "vb", EXTRA))),
    ).toBe(true);
    expect(events.some((e) => e.type === "reapply-done")).toBe(true);
  });

  it("conflict: ONE merge turn (worktree cwd) resolves; a staged-but-not-continued resolution is finished mechanically", async () => {
    const repo = await makeRepo();
    const { ops } = await seedChangeset(repo);
    // A post-selection edit on va touching the SAME file both variants rewrote.
    await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant(CS, "va"),
      path: CARD,
      content: "export function ProductCard() { return 'variant A, edited'; }\n",
      message: "edit: card",
    });
    await ops.setSelected(repo, CS, refVariant(CS, "vb"));

    const { orchestrator, turnCalls, events } = harness(async (params) => {
      // The merge turn resolves the conflict in the worktree but does NOT
      // run `cherry-pick --continue` — the server finishes mechanically.
      await writeFile(
        join(params.cwd, CARD),
        "export function ProductCard() { return 'variant B, edited'; }\n",
      );
      return { text: "resolved" };
    });
    const result = await orchestrator.reapply({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      fromRef: refVariant(CS, "va"),
    });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].mode).toBe("edit");
    expect(turnCalls[0].prompt).toContain("cherry-pick");
    expect(turnCalls[0].prompt).toBe(
      buildReapplyConflictPrompt({ fromLabel: "va", toLabel: "vb" }),
    );
    const tipB = (await ops.resolveCommit(repo, refVariant(CS, "vb")))!;
    expect(await ops.readBlob(repo, tipB, CARD)).toContain(
      "variant B, edited",
    );
    expect(events.some((e) => e.type === "reapply-conflict")).toBe(true);
    expect(events.some((e) => e.type === "reapply-done")).toBe(true);
  });

  it("total failure: the cherry-pick aborts, the target tip restores, and the edits stay on the old branch", async () => {
    const repo = await makeRepo();
    const { ops } = await seedChangeset(repo);
    const editTip = (await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant(CS, "va"),
      path: CARD,
      content: "export function ProductCard() { return 'variant A, edited'; }\n",
      message: "edit: card",
    }))!;
    await ops.setSelected(repo, CS, refVariant(CS, "vb"));
    const before = (await ops.resolveCommit(repo, refVariant(CS, "vb")))!;

    // The merge turn does NOTHING (the conflict stays unresolved).
    const { orchestrator, events } = harness(async () => ({ text: "" }));
    const result = await orchestrator.reapply({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      fromRef: refVariant(CS, "va"),
    });
    expect(result.error).toBeDefined();
    expect(await ops.resolveCommit(repo, refVariant(CS, "vb"))).toBe(before);
    expect(await ops.resolveCommit(repo, refVariant(CS, "va"))).toBe(editTip);
    expect(events.some((e) => e.type === "reapply-failed")).toBe(true);
    expect(events.some((e) => e.type === "reapply-done")).toBe(false);
  });

  it("refuses without a baseline or without pending commits", async () => {
    const repo = await makeRepo();
    const { ops } = await seedChangeset(repo);
    await ops.setSelected(repo, CS, refVariant(CS, "vb"));
    const { orchestrator } = harness();
    // No commits past va's generation tip.
    const nothing = await orchestrator.reapply({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      fromRef: refVariant(CS, "va"),
    });
    expect(nothing.error).toMatch(/Nothing to reapply/);
    // A ref without a recorded baseline (trunk) never reapplies.
    const noBaseline = await orchestrator.reapply({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      fromRef: refTrunk(CS),
    });
    expect(noBaseline.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// switchSelect → reapply-available.
// ---------------------------------------------------------------------------

describe("switchSelect reapply offer", () => {
  it("emits reapply-available when the previous branch has post-selection commits; never without a baseline", async () => {
    const repo = await makeRepo();
    const { ops } = await seedChangeset(repo);
    await ops.commitFileChange({
      repoRoot: repo,
      ref: refVariant(CS, "va"),
      path: EXTRA,
      content: "export const extra = 2;\n",
      message: "edit: extra",
    });
    const { events, orchestrator } = harness();
    const result = await orchestrator.switchSelect({
      repoRoot: repo,
      appDir: "",
      component: `${CARD}#`,
      selection: { changesetId: CS, variantId: "vb" },
    });
    expect(result.error).toBeUndefined();
    const offer = events.find((e) => e.type === "reapply-available");
    expect(offer).toMatchObject({
      changesetId: CS,
      fromRef: refVariant(CS, "va"),
      fromAlt: "va",
      toRef: refVariant(CS, "vb"),
      toAlt: "vb",
      count: 1,
    });

    // The offer SURVIVES the reload a switch triggers: status re-serves it.
    const status = await orchestrator.status(repo, "");
    expect(status.reapply).toMatchObject({ changesetId: CS, count: 1 });

    // Decline (dismiss) clears the server-held offer, touching nothing else.
    const before = await execFileAsync(
      "git",
      ["rev-parse", refVariant(CS, "va")],
      { cwd: repo },
    );
    const dismissed = await orchestrator.reapply({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      fromRef: refVariant(CS, "va"),
      dismiss: true,
    });
    expect(dismissed.error).toBeUndefined();
    expect((await orchestrator.status(repo, "")).reapply).toBeUndefined();
    expect(
      (await execFileAsync("git", ["rev-parse", refVariant(CS, "va")], { cwd: repo }))
        .stdout,
    ).toBe(before.stdout);

    // Switching BACK (vb has no post-generation commits) stays silent.
    events.length = 0;
    await orchestrator.switchSelect({
      repoRoot: repo,
      appDir: "",
      component: `${CARD}#`,
      selection: { changesetId: CS, variantId: "va" },
    });
    expect(events.some((e) => e.type === "reapply-available")).toBe(false);
    expect((await orchestrator.status(repo, "")).reapply).toBeUndefined();
  });
});
