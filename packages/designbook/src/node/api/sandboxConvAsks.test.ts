/**
 * Conversation-routed selection asks (docs/specs/changesets-on-git.md
 * §Conversation-routed asks) — the sandbox side of the seam:
 *
 *   - beginSelectionGitTurn/finishSelectionGitTurn: a selection-scoped
 *     conversation turn binds the SELECTED pin's changeset worktree, commits
 *     there, lands the changeset (wrapper/trunk card/activation), and the
 *     agent-supplied `Summary:` line becomes the catch-all commit subject +
 *     the returned label (`Title:` renames the ref);
 *   - fresh capture per message: refreshPinCapture + the composed selection
 *     turn message;
 *   - cross-selection memory (fake runner): the conversation transcript is
 *     append-only across selections — prior turns stay while the new
 *     message carries the NEW selection's fresh context;
 *   - variants from the conversation: the fan-out pipeline runs unchanged
 *     on the pin and reports THIS run's outcomes (pin thread keeps the
 *     record — back-compat);
 *   - ref display titles: prompt-derived fork names, agent `Title:` lines,
 *     and the USER-RENAME LOCK.
 *
 * Orchestrator against REAL temp git repos, FAKE turns (sandbox.test.ts
 * pattern — no Pi SDK, no auth).
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  changesetIdForPin,
  createSandboxOrchestrator,
  type SandboxRunTurn,
} from "./sandbox.ts";
import { changesetMetaPath, parseLayerMeta } from "../overrides/layerStore.ts";

const execFileAsync = promisify(execFile);

const cleanups: string[] = [];
const settlers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (settlers.length > 0) await settlers.pop()!();
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
  const root = await mkdtemp(join(tmpdir(), "db-convasks-"));
  cleanups.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src/Card.tsx"),
    "export function ProductCard() { return null; }\n",
  );
  await writeFile(
    join(root, "src/Hero.tsx"),
    "export function Hero() { return null; }\n",
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
  const records: Array<{ label?: string; changesetId: string }> = [];
  const orchestrator = createSandboxOrchestrator({
    runTurn: runTurn ?? (async () => ({ text: "" })),
    runTypecheck: async () => ({ ok: true }),
    broadcast: (eventName, payload) => {
      if (eventName === "sandbox-event") events.push(payload as Emitted);
    },
    log: () => {},
    sleep: async () => {},
    recordTurn: (entry) => {
      records.push({
        changesetId: entry.changesetId,
        ...(entry.label ? { label: entry.label } : {}),
      });
    },
  });
  settlers.push(() => orchestrator.settle());
  return { events, orchestrator, records };
}

const CARD_TARGET = {
  file: "src/Card.tsx",
  exportName: "ProductCard",
  name: "Product Card",
};
const HERO_TARGET = { file: "src/Hero.tsx", exportName: "Hero", name: "Hero" };

async function gitLog1(repo: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["log", "-1", "--format=%s", ref],
    { cwd: repo },
  );
  return stdout.trim();
}

describe("conversation-routed selection turns", () => {
  it("binds the pin's changeset workspace, commits there with the agent summary, lands the changeset, and applies Title:", async () => {
    const repo = await makeRepo();
    const { orchestrator } = harness();
    const { id: pinId } = await orchestrator.createPin({
      repoRoot: repo,
      appDir: "",
      target: CARD_TARGET,
      contextSnapshot: { props: { tone: "light" } },
    });
    const begun = await orchestrator.beginSelectionGitTurn({
      repoRoot: repo,
      appDir: "",
      pinId: pinId!,
      conversationId: "conv-1",
      promptText: "make the card red",
    });
    if ("error" in begun) throw new Error(begun.error);
    const csId = changesetIdForPin(pinId!);
    expect(begun.handle.changesetId).toBe(csId);
    expect(begun.handle.fresh).toBe(true);

    // The pin's busy latch: a concurrent pin-thread run is refused.
    expect(
      orchestrator.ask({ pinId: pinId!, prompt: "x", repoRoot: repo, appDir: "" })
        .error,
    ).toMatch(/run in progress/);

    // Simulate the CONVERSATION session editing the real path in the
    // changeset worktree (no per-write commit — the catch-all sweeps it
    // with the agent's Summary as subject).
    await writeFile(
      join(begun.handle.worktreeAbs, "src/Card.tsx"),
      "export function ProductCard() { return 'red'; }\n",
    );
    const finished = await orchestrator.finishSelectionGitTurn({
      repoRoot: repo,
      appDir: "",
      conversationId: "conv-1",
      handle: begun.handle,
      sessionId: "sess-1",
      turnIndex: 1,
      request: "make the card red",
      replyText: "Done — the card is red now.\n\nSummary: made the product card red\nTitle: Red card",
    });
    expect(finished.changesetId).toBe(csId);
    expect(finished.commits.length).toBe(1);
    expect(finished.label).toBe("made the product card red");
    expect(finished.files).toContain("src/Card.tsx");
    // Catch-all commit subject = the Summary line.
    expect(await gitLog1(repo, finished.ref)).toBe(
      "made the product card red",
    );
    // The changeset materialized: layer meta on disk, active, trunk card
    // registered, agent Title stored on the trunk ref.
    const meta = parseLayerMeta(
      await readFile(join(repo, changesetMetaPath("", csId)), "utf8"),
    )!;
    expect(meta.active).toBe(true);
    expect(Object.keys(meta.overrides)).toContain("src/Card.tsx");
    const trunkTitle = Object.values(meta.refTitles ?? {})[0];
    expect(trunkTitle?.title).toBe("Red card");
    expect(trunkTitle?.source).toBe("agent");
    // Busy latch released.
    expect(
      orchestrator.ask({ pinId: pinId!, prompt: "x", repoRoot: repo, appDir: "" })
        .error,
    ).toBeUndefined();
    await orchestrator.settle();
  });

  it("fresh capture per message: refreshPinCapture feeds the composed selection message", async () => {
    const repo = await makeRepo();
    const { orchestrator } = harness();
    const { id: pinId } = await orchestrator.createPin({
      repoRoot: repo,
      appDir: "",
      target: CARD_TARGET,
      contextSnapshot: { props: { tone: "light" } },
    });
    const stale = orchestrator.buildSelectionTurnMessage({
      repoRoot: repo,
      appDir: "",
      pinId: pinId!,
      request: "darker please",
    });
    expect(stale.message).toContain('"light"');

    await orchestrator.refreshPinCapture({
      repoRoot: repo,
      appDir: "",
      pinId: pinId!,
      contextSnapshot: { props: { tone: "dark", density: "compact" } },
    });
    const composed = orchestrator.buildSelectionTurnMessage({
      repoRoot: repo,
      appDir: "",
      pinId: pinId!,
      request: "darker please",
    });
    expect(composed.label).toBe("Product Card");
    expect(composed.message).toContain(
      `[Selection: Product Card] (pin ${pinId})`,
    );
    expect(composed.message).toContain("Captured props");
    expect(composed.message).toContain('"dark"');
    expect(composed.message).not.toContain('"light"');
    expect(composed.message).toContain("User request:\ndarker please");
  });

  it("cross-selection memory (fake runner): the transcript keeps prior turns while the new message carries the NEW selection's context", async () => {
    const repo = await makeRepo();
    const { orchestrator } = harness();
    const { id: pinA } = await orchestrator.createPin({
      repoRoot: repo,
      appDir: "",
      target: CARD_TARGET,
      contextSnapshot: { props: { radius: 4 } },
    });
    const { id: pinB } = await orchestrator.createPin({
      repoRoot: repo,
      appDir: "",
      target: HERO_TARGET,
      contextSnapshot: { props: { layout: "wide" } },
    });

    // FAKE RUNNER: one persistent conversation = one append-only transcript.
    const transcript: Array<{ role: string; content: string }> = [];
    const turnA = orchestrator.buildSelectionTurnMessage({
      repoRoot: repo,
      appDir: "",
      pinId: pinA!,
      request: "round the corners and add a soft shadow",
    });
    transcript.push({ role: "user", content: turnA.message! });
    transcript.push({
      role: "assistant",
      content: "Rounded the corners to 12px and added a soft shadow.",
    });

    // Select B, reference A's work purely conversationally.
    const turnB = orchestrator.buildSelectionTurnMessage({
      repoRoot: repo,
      appDir: "",
      pinId: pinB!,
      request: "make this match what we did to the first one",
    });
    transcript.push({ role: "user", content: turnB.message! });

    // Memory: the prior selection's turn is STILL in the transcript the
    // session reads (nothing was reset by switching selections)…
    expect(transcript[0].content).toContain("Product Card");
    expect(transcript[1].content).toContain("Rounded the corners");
    // …and the new turn carries the NEW selection's fresh context.
    expect(transcript[2].content).toContain("[Selection: Hero]");
    expect(transcript[2].content).toContain('"wide"');
    expect(transcript[2].content).toContain(
      "make this match what we did to the first one",
    );
    // Different selection = different changeset workspace for the turn.
    const wsA = await orchestrator.selectionChangesetId({
      repoRoot: repo,
      appDir: "",
      pinId: pinA!,
    });
    const wsB = await orchestrator.selectionChangesetId({
      repoRoot: repo,
      appDir: "",
      pinId: pinB!,
    });
    expect(wsA.changesetId).toBe(changesetIdForPin(pinA!));
    expect(wsB.changesetId).toBe(changesetIdForPin(pinB!));
    expect(wsA.changesetId).not.toBe(wsB.changesetId);
  });

  it("variants from the conversation: unchanged fan-out, THIS run's outcomes reported, pin thread keeps the record", async () => {
    const repo = await makeRepo();
    const { events, orchestrator } = harness(async (params) => {
      if (params.mode === "director") {
        return {
          text: '[{"slug":"warm","intent":"warmer palette"},{"slug":"cool","intent":"cooler palette"}]',
        };
      }
      if (params.mode === "variant") {
        // The arm edits the real path in its temp worktree.
        await writeFile(
          join(params.cwd, "src/Card.tsx"),
          `export function ProductCard() { return '${params.prompt.length}'; }\n`,
        );
        return { text: "done\n\nSummary: variant landed" };
      }
      return { text: "" };
    });
    const { id: pinId } = await orchestrator.createPin({
      repoRoot: repo,
      appDir: "",
      target: CARD_TARGET,
      contextSnapshot: {},
    });
    const result = await orchestrator.runConversationVariants({
      repoRoot: repo,
      appDir: "",
      pinId: pinId!,
      prompt: "give me a couple of color directions",
      n: 2,
    });
    expect(result.error).toBeUndefined();
    expect(result.variants?.map((variant) => variant.id).sort()).toEqual([
      "cool",
      "warm",
    ]);
    expect(
      result.variants?.every((variant) => variant.status === "ready"),
    ).toBe(true);
    // The conversational surface got the routed intent + progressive events.
    expect(
      events.find((event) => event.type === "intent-routed"),
    ).toMatchObject({ intent: "variants", n: 2 });
    expect(
      events.filter((event) => event.type === "variant-ready").length,
    ).toBe(2);
    // Pin-thread back-compat: the ask is recorded on the pin's own thread.
    const status = await orchestrator.status(repo, "");
    const pin = (status as { pins: Array<{ id: string; thread: Array<{ role: string; text: string }> }> }).pins.find(
      (candidate) => candidate.id === pinId,
    );
    expect(
      pin?.thread.some(
        (message) =>
          message.role === "user" &&
          message.text.includes("couple of color directions"),
      ),
    ).toBe(true);
    await orchestrator.settle();
  });

  it("ref titles: fork names derive from the creating prompt; a USER rename locks out agent Title: lines", async () => {
    const repo = await makeRepo();
    const { orchestrator } = harness();
    const { id: pinId } = await orchestrator.createPin({
      repoRoot: repo,
      appDir: "",
      target: CARD_TARGET,
      contextSnapshot: {},
    });
    const csId = changesetIdForPin(pinId!);

    // Turn 1 + turn 2 on the trunk (park needs a mid-history commit).
    for (const [index, body] of ["one", "two"].entries()) {
      const begun = await orchestrator.beginSelectionGitTurn({
        repoRoot: repo,
        appDir: "",
        pinId: pinId!,
        conversationId: "conv-1",
      });
      if ("error" in begun) throw new Error(begun.error);
      await writeFile(
        join(begun.handle.worktreeAbs, "src/Card.tsx"),
        `export function ProductCard() { return '${body}'; }\n`,
      );
      await orchestrator.finishSelectionGitTurn({
        repoRoot: repo,
        appDir: "",
        conversationId: "conv-1",
        handle: begun.handle,
        sessionId: "sess-1",
        turnIndex: index + 1,
        replyText: `ok\n\nSummary: turn ${index + 1}`,
      });
    }

    // Park at turn 1's commit, then the implicit fork with a naming prompt.
    const graph = await orchestrator.historyGraph({
      repoRoot: repo,
      appDir: "",
      changesetId: csId,
      turns: [],
    });
    const trunk = graph.changesets![0].refs.find(
      (ref) => ref.kind === "trunk",
    )!;
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", `${trunk.tip}~1`],
      { cwd: repo },
    );
    const parkCommit = stdout.trim();
    const parked = await orchestrator.park({
      repoRoot: repo,
      appDir: "",
      changesetId: csId,
      commit: parkCommit,
    });
    expect(parked.error).toBeUndefined();
    const forked = await orchestrator.forkFromPark({
      repoRoot: repo,
      appDir: "",
      changesetId: csId,
      promptText: "Make the hero section bigger and bolder",
    });
    expect(forked.altId).toBeTruthy();

    // The fork pill's initial name = the creating prompt, truncated to 10.
    const afterFork = await orchestrator.historyGraph({
      repoRoot: repo,
      appDir: "",
      changesetId: csId,
      turns: [],
    });
    const forkRef = afterFork.changesets![0].refs.find(
      (ref) => ref.altId === forked.altId,
    )!;
    expect(forkRef.title).toBe("Make the h…");

    // USER rename → locked.
    const renamed = await orchestrator.renameRef({
      repoRoot: repo,
      appDir: "",
      changesetId: csId,
      altId: forked.altId!,
      title: "Hero v2",
    });
    expect(renamed.error).toBeUndefined();

    // An agent Title: on the fork ref is now IGNORED.
    const begun = await orchestrator.beginSelectionGitTurn({
      repoRoot: repo,
      appDir: "",
      pinId: pinId!,
      conversationId: "conv-1",
    });
    if ("error" in begun) throw new Error(begun.error);
    expect(begun.handle.ref).toContain(forked.altId); // selection moved onto the fork
    await writeFile(
      join(begun.handle.worktreeAbs, "src/Card.tsx"),
      "export function ProductCard() { return 'fork edit'; }\n",
    );
    await orchestrator.finishSelectionGitTurn({
      repoRoot: repo,
      appDir: "",
      conversationId: "conv-1",
      handle: begun.handle,
      sessionId: "sess-1",
      turnIndex: 3,
      replyText: "ok\n\nSummary: fork edit\nTitle: Agent suggested name",
    });
    const finalGraph = await orchestrator.historyGraph({
      repoRoot: repo,
      appDir: "",
      changesetId: csId,
      turns: [],
    });
    const finalFork = finalGraph.changesets![0].refs.find(
      (ref) => ref.altId === forked.altId,
    )!;
    expect(finalFork.title).toBe("Hero v2");
    const meta = parseLayerMeta(
      await readFile(join(repo, changesetMetaPath("", csId)), "utf8"),
    )!;
    expect(meta.refTitles?.[forked.altId!]?.source).toBe("user");
    await orchestrator.settle();
  });
});
