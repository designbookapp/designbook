/**
 * G4 server surfaces (docs/specs/changesets-on-git.md §G4 — history
 * explorer):
 *
 *   - historyGraph: one conversation's DAG — refs with kinds/titles, fork
 *     topology (forkOfRef/forkCommit), per-turn nodes, selection, park;
 *   - park: a NON-DESTRUCTIVE preview — the cache projects the parked
 *     commit's state while every ref stays put; exit restores the tips;
 *   - forkFromPark: new work while parked cuts a new ref AT the parked
 *     commit, selection moves onto it, the park clears, and the reapply
 *     baseline (generatedTips) records the cut;
 *   - conversation fork binding: a sliced conversation resolves to the
 *     PARENT changeset it was cut onto (workspace + turn routing).
 *
 * Orchestrator against REAL temp git repos, FAKE turns (sandboxG2.test.ts
 * pattern — no Pi SDK, no auth).
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSandboxOrchestrator,
  type SandboxRunTurn,
} from "./sandbox.ts";
import { directChangesetId } from "./conversations.ts";
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
  const root = await mkdtemp(join(tmpdir(), "db-g4-"));
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

function harness(
  runTurn?: SandboxRunTurn,
  extra?: {
    onOverridesChanged?: (
      redirects: Record<string, string>,
      stamps: Record<string, number>,
    ) => void;
  },
) {
  const events: Emitted[] = [];
  const orchestrator = createSandboxOrchestrator({
    runTurn: async (params) => (runTurn ? runTurn(params) : { text: "" }),
    runTypecheck: async () => ({ ok: true }),
    broadcast: (eventName, payload) => {
      if (eventName === "sandbox-event") events.push(payload as Emitted);
    },
    log: () => {},
    sleep: async () => {},
    ...(extra?.onOverridesChanged
      ? { onOverridesChanged: extra.onOverridesChanged }
      : {}),
  });
  settlers.push(() => orchestrator.settle());
  return { events, orchestrator };
}

const CS = "cs-g4";
const CARD = "src/Card.tsx";

/**
 * Seed a pin changeset straight through the git core: trunk + variant `va`
 * carrying TWO turn commits (t1, t2) + variant `vb` with one, selection on
 * va, and a persisted layer meta. Returns the shas.
 */
async function seedChangeset(repo: string) {
  const ops = createGitChangesets();
  const refs = await ops.ensureChangesetRefs(repo, CS);
  await ops.cutVariantBranch(repo, CS, "va");
  await ops.cutVariantBranch(repo, CS, "vb");
  const t1 = await ops.commitFileChange({
    repoRoot: repo,
    ref: refVariant(CS, "va"),
    path: CARD,
    content: "export function ProductCard() { return 'va turn 1'; }\n",
    message: "turn 1",
  });
  const t2 = await ops.commitFileChange({
    repoRoot: repo,
    ref: refVariant(CS, "va"),
    path: CARD,
    content: "export function ProductCard() { return 'va turn 2'; }\n",
    message: "turn 2",
  });
  const b1 = await ops.commitFileChange({
    repoRoot: repo,
    ref: refVariant(CS, "vb"),
    path: CARD,
    content: "export function ProductCard() { return 'vb turn 1'; }\n",
    message: "vb turn 1",
  });
  const meta: ChangesetLayer = {
    id: CS,
    pinId: "pin-g4",
    branch: "main",
    baseCommit: refs.baseCommit,
    createdAt: 1,
    active: true,
    order: 1,
    baseHashes: {},
    overrides: { [CARD]: { selection: "va", alternatives: ["va", "vb"] } },
    generatedTips: { va: t1, vb: b1 },
  };
  const metaAbs = join(repo, changesetMetaPath("", CS));
  await mkdir(join(metaAbs, ".."), { recursive: true });
  await writeFile(metaAbs, serializeLayerMeta(meta));
  await ops.setSelected(repo, CS, refVariant(CS, "va"));
  return { ops, base: refs.baseCommit, t1, t2, b1 };
}

const vaAlt = (repo: string) => join(repo, altFilePath("", CS, "va", CARD));

describe("history graph (G4)", () => {
  it("returns refs with kinds, fork topology, turns, selection and park", async () => {
    const repo = await makeRepo();
    const { ops, base, t1, t2 } = await seedChangeset(repo);
    const { orchestrator } = harness();
    const turns = [
      {
        turn: "sess/1",
        conversationId: "conv-1",
        changesetId: CS,
        ref: refVariant(CS, "va"),
        from: base,
        to: t1,
        at: 100,
      },
      {
        turn: "sess/2",
        conversationId: "conv-1",
        changesetId: CS,
        ref: refVariant(CS, "va"),
        from: t1,
        to: t2,
        at: 200,
      },
    ];
    const graph = await orchestrator.historyGraph({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      turns,
    });
    expect(graph.error).toBeUndefined();
    const cs = graph.changesets![0];
    expect(cs.id).toBe(CS);
    expect(cs.base).toBe(base);
    expect(cs.selectedRef).toBe(refVariant(CS, "va"));
    const kinds = Object.fromEntries(
      cs.refs.map((rail) => [rail.altId, rail.kind]),
    );
    expect(kinds).toEqual({ edit: "trunk", va: "variant", vb: "variant" });
    const va = cs.refs.find((rail) => rail.altId === "va")!;
    expect(va.tip).toBe(t2);
    expect(va.forkOfRef).toBe(refTrunk(CS));
    expect(va.forkCommit).toBe(base); // Cut at the trunk tip (= base here).
    expect(cs.turns.map((node) => node.commit)).toEqual([t1, t2]);
    expect(cs.parked).toBeUndefined();

    // A fork ref reports kind "fork" + its parent rail (va, not trunk).
    await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: t1,
      turn: "sess/1",
    });
    const forked = await orchestrator.forkFromPark({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
    });
    expect(forked.error).toBeUndefined();
    const graph2 = await orchestrator.historyGraph({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      turns,
    });
    const cs2 = graph2.changesets![0];
    const forkRail = cs2.refs.find((rail) => rail.kind === "fork")!;
    expect(forkRail.altId).toBe(forked.altId);
    expect(forkRail.forkCommit).toBe(t1);
    expect(forkRail.forkOfRef).toBe(refVariant(CS, "va"));
    expect(forkRail.fromTurn).toBe("sess/1");
    expect(cs2.selectedRef).toBe(forked.ref);
    // Selection ancestry data is complete: fork → va → trunk.
    expect(
      cs2.refs.find((rail) => rail.ref === forkRail.forkOfRef)?.forkOfRef,
    ).toBe(refTrunk(CS));
    void ops;
  });

  it("collects a conversation's changesets (direct id + pin conversation)", async () => {
    const repo = await makeRepo();
    const { base, t1 } = await seedChangeset(repo);
    const { orchestrator } = harness();
    // Tag the layer meta with a conversation id.
    const metaAbs = join(repo, changesetMetaPath("", CS));
    const meta = JSON.parse(await readFile(metaAbs, "utf8")) as ChangesetLayer;
    meta.conversationId = "conv-9";
    await writeFile(metaAbs, serializeLayerMeta(meta));
    const graph = await orchestrator.historyGraph({
      repoRoot: repo,
      appDir: "",
      conversationId: "conv-9",
      turns: [
        {
          turn: "s/1",
          changesetId: CS,
          ref: refVariant(CS, "va"),
          from: base,
          to: t1,
          at: 1,
        },
      ],
    });
    expect(graph.changesets?.map((cs) => cs.id)).toEqual([CS]);
    expect(graph.conversationId).toBe("conv-9");
  });

  it("unions changesets the conversation LANDED turns on (reused pin from an older conversation)", () => {
    return (async () => {
      const repo = await makeRepo();
      const { base, t1 } = await seedChangeset(repo);
      const { orchestrator } = harness();
      // The layer meta belongs to an OLD conversation; a NEW conversation
      // reused the pin and landed a turn (sidecar record) — the graph must
      // still show the rail, with the turn attributable to conv-new.
      const metaAbs = join(repo, changesetMetaPath("", CS));
      const meta = JSON.parse(
        await readFile(metaAbs, "utf8"),
      ) as ChangesetLayer;
      meta.conversationId = "conv-old";
      await writeFile(metaAbs, serializeLayerMeta(meta));
      const turns = [
        {
          turn: "s/1",
          conversationId: "conv-new",
          changesetId: CS,
          ref: refVariant(CS, "va"),
          from: base,
          to: t1,
          at: 1,
        },
      ];
      const graph = await orchestrator.historyGraph({
        repoRoot: repo,
        appDir: "",
        conversationId: "conv-new",
        turns,
      });
      expect(graph.changesets?.map((cs) => cs.id)).toEqual([CS]);
      expect(graph.changesets![0].turns[0].conversationId).toBe("conv-new");

      // The status conversation summary groups the same way.
      const status = await orchestrator.status(repo, "", { turns });
      const grouped = status.conversations.find(
        (conversation) => conversation.id === "conv-new",
      );
      expect(grouped?.changesetIds).toEqual([CS]);
      // …without duplicating the meta conversation's own membership.
      const old = status.conversations.find(
        (conversation) => conversation.id === "conv-old",
      );
      expect(old?.changesetIds).toEqual([CS]);
    })();
  });
});

describe("park (G4) — non-destructive preview", () => {
  it("projects the parked commit's state without moving any ref; exit restores", async () => {
    const repo = await makeRepo();
    const { ops, t1, t2 } = await seedChangeset(repo);
    const { events, orchestrator } = harness();

    // Sanity: the projected cache serves the tip before parking.
    await orchestrator.status(repo, "");
    expect(await readFile(vaAlt(repo), "utf8")).toContain("va turn 2");

    const parked = await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: t1,
      ref: refVariant(CS, "va"),
      turn: "sess/1",
    });
    expect(parked.error).toBeUndefined();
    expect(parked.parked).toEqual({
      commit: t1,
      ref: refVariant(CS, "va"),
      turn: "sess/1",
    });
    // The CACHE shows the older design…
    expect(await readFile(vaAlt(repo), "utf8")).toContain("va turn 1");
    // …while every ref is exactly where it was (for-each-ref truth).
    expect(await ops.resolveCommit(repo, refVariant(CS, "va"))).toBe(t2);
    expect(await ops.getSelected(repo, CS)).toBe(refVariant(CS, "va"));
    expect(events.some((event) => event.type === "parked")).toBe(true);
    // The wire changeset carries the park pointer (banner + graph marker).
    const status = await orchestrator.status(repo, "");
    const wire = status.changesets.find((cs) => cs.id === CS) as {
      parked?: { commit: string; turn?: string };
    };
    expect(wire.parked?.commit).toBe(t1);
    expect(wire.parked?.turn).toBe("sess/1");

    // Exit: back to the selected tip.
    const exited = await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: null,
    });
    expect(exited.error).toBeUndefined();
    expect(await readFile(vaAlt(repo), "utf8")).toContain("va turn 2");
    expect(await ops.resolveCommit(repo, refVariant(CS, "va"))).toBe(t2);
    expect(events.some((event) => event.type === "unparked")).toBe(true);
  });

  it("rejects commits outside the changeset and parks at tips as a no-op", async () => {
    const repo = await makeRepo();
    const { t2 } = await seedChangeset(repo);
    const { orchestrator } = harness();
    const bogus = await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: "deadbeef",
    });
    expect(bogus.error).toBe("Unknown commit.");
    // Parking AT the selected tip is a no-op (nothing to preview).
    const tip = await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: t2,
    });
    expect(tip.error).toBeUndefined();
    const status = await orchestrator.status(repo, "");
    const wire = status.changesets.find((cs) => cs.id === CS) as {
      parked?: unknown;
    };
    expect(wire.parked).toBeUndefined();
  });

  it("restore (rollback) still works while parked — the park just clears", async () => {
    const repo = await makeRepo();
    const { ops, t1, t2 } = await seedChangeset(repo);
    const { orchestrator } = harness();
    await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: t1,
    });
    const rolled = await orchestrator.rollback({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: t1,
      ref: refVariant(CS, "va"),
    });
    expect(rolled.error).toBeUndefined();
    expect(await ops.resolveCommit(repo, refVariant(CS, "va"))).toBe(t1);
    const status = await orchestrator.status(repo, "");
    const wire = status.changesets.find((cs) => cs.id === CS) as {
      parked?: unknown;
    };
    expect(wire.parked).toBeUndefined();
    void t2;
  });
});

describe("implicit fork (G4)", () => {
  it("cuts a new ref at the parked commit, selects it, clears the park", async () => {
    const repo = await makeRepo();
    const { ops, t1, t2 } = await seedChangeset(repo);
    const { events, orchestrator } = harness();
    await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: t1,
      ref: refVariant(CS, "va"),
      turn: "sess/1",
    });
    const forked = await orchestrator.forkFromPark({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
    });
    expect(forked.error).toBeUndefined();
    expect(forked.altId).toMatch(/^fork-/);
    expect(forked.commit).toBe(t1);
    expect(forked.fromTurn).toBe("sess/1");
    // The fork ref sits at the parked commit; va is untouched.
    expect(await ops.resolveCommit(repo, forked.ref!)).toBe(t1);
    expect(await ops.resolveCommit(repo, refVariant(CS, "va"))).toBe(t2);
    // Selection moved to the fork; the park is gone.
    expect(await ops.getSelected(repo, CS)).toBe(forked.ref);
    const status = await orchestrator.status(repo, "");
    const wire = status.changesets.find((cs) => cs.id === CS) as {
      parked?: unknown;
      overrides: Array<{ alternatives: string[]; selection?: string }>;
    };
    expect(wire.parked).toBeUndefined();
    // The projection grew the fork's alternative and selected it.
    const card = wire.overrides.find((o) =>
      o.alternatives.includes(forked.altId!),
    );
    expect(card?.selection).toBe(forked.altId);
    expect(
      await readFile(join(repo, altFilePath("", CS, forked.altId!, CARD)), "utf8"),
    ).toContain("va turn 1");
    // Reapply baseline recorded at the cut (a later switch away offers
    // post-fork commits, not the inherited history).
    const metaAbs = join(repo, changesetMetaPath("", CS));
    const meta = JSON.parse(await readFile(metaAbs, "utf8")) as ChangesetLayer;
    expect(meta.generatedTips?.[forked.altId!]).toBe(t1);
    expect(meta.forks?.[forked.altId!]?.forkCommit).toBe(t1);
    expect(events.some((event) => event.type === "forked")).toBe(true);
    // Not parked → refuses.
    const again = await orchestrator.forkFromPark({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
    });
    expect(again.error).toBe("This changeset is not parked.");
  });

  it("binds a sliced conversation to the parent changeset (workspace + routing)", async () => {
    const repo = await makeRepo();
    const { t1 } = await seedChangeset(repo);
    const { orchestrator } = harness();
    await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: t1,
    });
    const forked = await orchestrator.forkFromPark({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
    });
    const bound = await orchestrator.bindForkConversation({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      altId: forked.altId!,
      conversationId: "conv-fork",
    });
    expect(bound.error).toBeUndefined();
    // The forked conversation resolves to the PARENT changeset…
    expect(
      await orchestrator.conversationChangesetId({
        repoRoot: repo,
        appDir: "",
        conversationId: "conv-fork",
      }),
    ).toBe(CS);
    // …and its workspace attaches to that changeset's worktree.
    const workspace = await orchestrator.ensureConversationWorkspace({
      repoRoot: repo,
      appDir: "",
      conversationId: "conv-fork",
    });
    expect(workspace?.changesetId).toBe(CS);
    // An unrelated conversation still gets its own direct-edits id.
    expect(
      await orchestrator.conversationChangesetId({
        repoRoot: repo,
        appDir: "",
        conversationId: "conv-other",
      }),
    ).toBe(directChangesetId("conv-other"));
    // The graph reports the fork's conversation binding (pill title join).
    const graph = await orchestrator.historyGraph({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      turns: [],
    });
    const rail = graph.changesets![0].refs.find((r) => r.kind === "fork")!;
    expect(rail.forkConversationId).toBe("conv-fork");
  });
});

describe("projection → hot-update ordering (round-2 canvas staleness)", () => {
  it("park / exit / rollback re-projections at UNCHANGED paths still push (content stamps), and every push happens AFTER the bytes landed", async () => {
    const repo = await makeRepo();
    const { t1 } = await seedChangeset(repo);
    const pushes: Array<{
      redirects: Record<string, string>;
      stamps: Record<string, number>;
      /** The projected alt's bytes AT PUSH TIME — ordering proof. */
      altBytes: string;
    }> = [];
    const { orchestrator } = harness(undefined, {
      onOverridesChanged: (redirects, stamps) => {
        pushes.push({
          redirects: { ...redirects },
          stamps: { ...stamps },
          altBytes: readFileSync(vaAlt(repo), "utf8"),
        });
      },
    });
    const realAbs = join(repo, CARD);

    // Initial revive projects the tips and pushes the table once.
    await orchestrator.status(repo, "");
    expect(pushes.length).toBe(1);
    expect(pushes[0].redirects[realAbs]).toBe(vaAlt(repo));
    expect(pushes[0].altBytes).toContain("va turn 2");
    const stampAtTip = pushes[0].stamps[realAbs];
    expect(typeof stampAtTip).toBe("number");

    // PARK at t1: table paths identical, content re-projected — the stamp
    // must bump and the push must see the PARKED bytes already on disk
    // (this was the canvas-staleness bug: no push, watcher-only).
    await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: t1,
      ref: refVariant(CS, "va"),
    });
    expect(pushes.length).toBe(2);
    expect(pushes[1].redirects[realAbs]).toBe(vaAlt(repo));
    expect(pushes[1].stamps[realAbs]).not.toBe(stampAtTip);
    expect(pushes[1].altBytes).toContain("va turn 1");

    // EXIT: back to the tip — another content-only push, bytes restored
    // before the push.
    await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: null,
    });
    expect(pushes.length).toBe(3);
    expect(pushes[2].stamps[realAbs]).not.toBe(pushes[1].stamps[realAbs]);
    expect(pushes[2].altBytes).toContain("va turn 2");

    // ROLLBACK to t1 (ref moves, paths unchanged): stamp bumps again, and
    // the rolled-back bytes are on disk at push time.
    const rolled = await orchestrator.rollback({
      repoRoot: repo,
      appDir: "",
      changesetId: CS,
      commit: t1,
      ref: refVariant(CS, "va"),
    });
    expect(rolled.error).toBeUndefined();
    expect(pushes.length).toBe(4);
    expect(pushes[3].stamps[realAbs]).not.toBe(pushes[2].stamps[realAbs]);
    expect(pushes[3].altBytes).toContain("va turn 1");
  });
});
