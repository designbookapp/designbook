/**
 * Conversations on git (L3 semantics over the G1 engine —
 * docs/specs/changesets-on-git.md):
 *
 *   - conversation identity: ids, the transcript sidecar store (legacy flat
 *     map + G1 {sessions,turns} shape), history-row linkage, per-turn
 *     commit-range records;
 *   - conversationId stamping: pin → changeset → status grouping;
 *   - direct-edits changesets: manual data edits become plumbing COMMITS on
 *     the conversation's hidden trunk (real file byte-clean, served
 *     merged), discard deletes refs+layer, bake writes the mutation into
 *     the real file;
 *   - conversation turn capture: tool/bash writes in the conversation
 *     WORKTREE commit per-write (or via the finish catch-all) and project
 *     onto the direct-edits layer — the bash lift-and-restore machinery is
 *     gone;
 *   - data CHANGES machinery: mutations carry for direct layers, additive
 *     layers unchanged by construction;
 *   - branch filtering surface: listChangesets(allBranches) tags foreign
 *     layers; the default listing still hides them.
 *
 * Orchestrator tests run against FAKE turns in REAL temp git repos (the
 * sandbox.test.ts pattern — no Pi SDK, no auth).
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSandboxOrchestrator,
  type SandboxRunTurn,
} from "./sandbox.ts";
import {
  DATA_ALT_ID,
  altFilePath,
  changesetMetaPath,
  changesetsDir,
  mergedDataPath,
  parseLayerMeta,
  serializeLayerMeta,
  type ChangesetLayer,
} from "../overrides/layerStore.ts";
import {
  DIRECT_ALT_ID,
  directChangesetId,
  isDirectChangesetId,
  makeConversationId,
  parseConversationStore,
  readConversationMap,
  readConversationStore,
  recordConversationTag,
  recordTurnRange,
} from "./conversations.ts";
import { isValidIdSegment } from "./sandbox.ts";
import {
  applyDataChanges,
  computeDataChanges,
  mergeDataLayers,
} from "./dataMerge.ts";
import { listChatThreads } from "./sandboxThreads.ts";
import { replaceJsonStringValue } from "./jsonEdit.ts";

const cleanups: string[] = [];
/** Each harness's orchestrator.settle — drained before the temp repos go
 * (same discipline as sandbox.test.ts: an in-flight fire-and-forget persist
 * re-creates .designbook mid-teardown → ENOTEMPTY under parallel load). */
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

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "db-l3-"));
  cleanups.push(root);
  await mkdir(join(root, "src/locales"), { recursive: true });
  await writeFile(
    join(root, "src/Card.tsx"),
    "export function ProductCard() { return null; }\n",
  );
  await writeFile(
    join(root, "src/locales/en.json"),
    '{\n  "title": "Hello",\n  "cta": "Buy now"\n}\n',
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
  const orchestrator = createSandboxOrchestrator({
    runTurn: runTurn ?? (async () => ({ text: "" })),
    runTypecheck: async () => ({ ok: true }),
    broadcast: (eventName, payload) => {
      if (eventName === "sandbox-event") events.push(payload as Emitted);
    },
    log: () => {},
    sleep: async () => {},
  });
  settlers.push(() => orchestrator.settle());
  return { events, orchestrator };
}

const LOCALE = "src/locales/en.json";

// ---------------------------------------------------------------------------
// Conversation identity.
// ---------------------------------------------------------------------------

describe("conversation identity", () => {
  it("mints ids usable inside changeset id segments", () => {
    const id = makeConversationId(1234567);
    expect(isValidIdSegment(id)).toBe(true);
    expect(isValidIdSegment(directChangesetId(id))).toBe(true);
    expect(isDirectChangesetId(directChangesetId(id))).toBe(true);
    expect(isDirectChangesetId("productcard-x1")).toBe(false);
  });

  it("records + reads the sidecar map (merge, queued writes)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "db-l3-map-"));
    cleanups.push(dir);
    await Promise.all([
      recordConversationTag({
        sessionDir: dir,
        sessionId: "s1",
        conversationId: "c-one",
      }),
      recordConversationTag({
        sessionDir: dir,
        sessionId: "s2",
        conversationId: "c-two",
      }),
    ]);
    expect(await readConversationMap(dir)).toEqual({
      s1: "c-one",
      s2: "c-two",
    });
    // Empty ids are dropped; corrupt files read as empty.
    await recordConversationTag({
      sessionDir: dir,
      sessionId: "",
      conversationId: "c-three",
    });
    expect(Object.keys(await readConversationMap(dir))).toHaveLength(2);
    expect(await readConversationMap(join(dir, "missing"))).toEqual({});
  });

  it("records per-turn commit ranges (G1 sidecar) and reads the legacy flat map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "db-l3-turns-"));
    cleanups.push(dir);
    await recordConversationTag({
      sessionDir: dir,
      sessionId: "s1",
      conversationId: "c-one",
    });
    await recordTurnRange({
      sessionDir: dir,
      record: {
        turn: "s1/3",
        conversationId: "c-one",
        changesetId: "cs-x",
        ref: "refs/designbook/changesets/cs-x/trunk",
        from: "aaa",
        to: "bbb",
        at: 123,
      },
    });
    const store = await readConversationStore(dir);
    expect(store.sessions).toEqual({ s1: "c-one" });
    expect(store.turns).toEqual([
      {
        turn: "s1/3",
        conversationId: "c-one",
        changesetId: "cs-x",
        ref: "refs/designbook/changesets/cs-x/trunk",
        from: "aaa",
        to: "bbb",
        at: 123,
      },
    ]);
    // Legacy flat-map bodies still read as sessions.
    const legacy = parseConversationStore('{"s9": "c-legacy"}');
    expect(legacy.sessions).toEqual({ s9: "c-legacy" });
    expect(legacy.turns).toEqual([]);
  });

  it("history rows keep their conversation linkage (listChatThreads join)", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-l3-threads-"));
    cleanups.push(root);
    const cwd = join(root, "repo");
    const sessionDir = join(root, "sessions");
    const manager = SessionManager.create(cwd, sessionDir);
    // The SDK only flushes a session once it has an ASSISTANT message.
    for (const message of [
      { role: "user", text: "make the hero pop" },
      { role: "assistant", text: "Done." },
    ]) {
      manager.appendMessage({
        role: message.role,
        content: [{ type: "text", text: message.text }],
        timestamp: Date.now(),
      } as never);
    }
    const threads = await listChatThreads({
      cwd,
      sessionDir,
      conversationTags: {
        [(await SessionManager.list(cwd, sessionDir))[0]!.id]: "c-linked",
      },
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ conversationId: "c-linked" });
    // Untagged transcripts stay linkage-free (wire compat).
    const untagged = await listChatThreads({ cwd, sessionDir });
    expect(untagged[0]).not.toHaveProperty("conversationId");
  });
});

// ---------------------------------------------------------------------------
// Stamping + grouping.
// ---------------------------------------------------------------------------

describe("conversation stamping + status grouping", () => {
  it("pin → changeset inherit the conversationId; status groups them", async () => {
    const repoRoot = await makeRepo();
    const { events: harnessEvents, orchestrator } = harness(async (params) => {
      // G1: the fake agent writes into the turn's WORKTREE cwd.
      await writeFile(
        join(params.cwd, "src/Card.tsx"),
        "export function ProductCard() { return <b>edited</b>; }\n",
      );
      return { text: "done" };
    });
    const created = await orchestrator.createPin({
      repoRoot,
      appDir: "",
      target: { file: "src/Card.tsx", exportName: "ProductCard", name: "Card" },
      contextSnapshot: {},
      conversationId: "c-live",
    });
    expect(created.id).toBeTruthy();
    // One edit-framed turn registers the changeset.
    const result = orchestrator.prompt({
      pinId: created.id!,
      prompt: "make it bolder",
      mode: "edit",
    });
    expect(result.error).toBeUndefined();
    // Wait for the TURN to finish (not just the changeset to appear) so no
    // background write races the temp-dir cleanup.
    for (
      let i = 0;
      i < 400 && !harnessEvents.some((e) => e.type === "turn-end");
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const status = await orchestrator.status(repoRoot, "");
    expect(status.pins[0]).toMatchObject({ conversationId: "c-live" });
    expect(status.changesets[0]).toMatchObject({
      conversationId: "c-live",
      direct: false,
    });
    expect(status.conversations).toEqual([
      {
        id: "c-live",
        changesetIds: [status.changesets[0]!.id],
        pinIds: [created.id],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Direct-edits changesets (manual data edits).
// ---------------------------------------------------------------------------

describe("direct-edits changeset", () => {
  it("stages a text-tool edit into the conversation's layer: real file byte-clean, merged artifact serves, discard reverts", async () => {
    const repoRoot = await makeRepo();
    const { orchestrator } = harness();
    const original = await readFile(join(repoRoot, LOCALE), "utf8");

    const staged = await orchestrator.stageDirectDataEdit({
      repoRoot,
      appDir: "",
      conversationId: "c-1",
      rel: LOCALE,
      apply: (current) => {
        const updated = replaceJsonStringValue(current, "title", "Howdy");
        return updated === undefined
          ? { error: "Key not found or not a string: title" }
          : { updated };
      },
    });
    expect(staged).toMatchObject({ staged: true });

    // Real file untouched.
    expect(await readFile(join(repoRoot, LOCALE), "utf8")).toBe(original);

    // The layer exists, pin-less, conversation-owned, additions carry the
    // MUTATED key.
    const status = await orchestrator.status(repoRoot, "");
    const changesetId = directChangesetId("c-1");
    const direct = status.changesets.find((c) => c.id === changesetId)!;
    expect(direct).toMatchObject({
      threadPinId: "",
      conversationId: "c-1",
      direct: true,
      active: true,
      dataAdditionCount: 1,
    });

    // Served merged: the artifact carries the new value; the redirect table
    // maps the real file onto it.
    const mergedAbs = join(repoRoot, mergedDataPath("", LOCALE));
    const merged = JSON.parse(await readFile(mergedAbs, "utf8"));
    expect(merged.title).toBe("Howdy");
    expect(merged.cta).toBe("Buy now");
    const redirects = await orchestrator.redirects(repoRoot, "");
    expect(redirects.redirects[join(repoRoot, LOCALE)]).toBe(mergedAbs);

    // Second edit on ANOTHER key accumulates on the SAME layer; a key edited
    // back to its base value self-cleans.
    await orchestrator.stageDirectDataEdit({
      repoRoot,
      appDir: "",
      conversationId: "c-1",
      rel: LOCALE,
      apply: (current) => ({
        updated: replaceJsonStringValue(current, "cta", "Add to cart")!,
      }),
    });
    await orchestrator.stageDirectDataEdit({
      repoRoot,
      appDir: "",
      conversationId: "c-1",
      rel: LOCALE,
      apply: (current) => ({
        updated: replaceJsonStringValue(current, "title", "Hello")!,
      }),
    });
    const after = await orchestrator.status(repoRoot, "");
    const direct2 = after.changesets.find((c) => c.id === changesetId)!;
    expect(direct2.dataAdditionCount).toBe(1); // only cta remains changed
    const merged2 = JSON.parse(await readFile(mergedAbs, "utf8"));
    expect(merged2.title).toBe("Hello");
    expect(merged2.cta).toBe("Add to cart");

    // Discard reverts: layer dir gone, redirect dropped, real file pristine.
    const discarded = await orchestrator.discard({
      repoRoot,
      appDir: "",
      changesetId,
    });
    expect(discarded.error).toBeUndefined();
    expect(
      existsSync(join(repoRoot, changesetsDir(""), changesetId)),
    ).toBe(false);
    const redirectsAfter = await orchestrator.redirects(repoRoot, "");
    expect(redirectsAfter.redirects[join(repoRoot, LOCALE)]).toBeUndefined();
    expect(await readFile(join(repoRoot, LOCALE), "utf8")).toBe(original);
  });

  it("bakes a direct-edits changeset like any other: mutation lands in the real file, layer dissolves", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness();
    await orchestrator.stageDirectDataEdit({
      repoRoot,
      appDir: "",
      conversationId: "c-2",
      rel: LOCALE,
      apply: (current) => ({
        updated: replaceJsonStringValue(current, "title", "Baked title")!,
      }),
    });
    const changesetId = directChangesetId("c-2");
    const admitted = await orchestrator.bake({
      repoRoot,
      appDir: "",
      changesetId,
    });
    expect(admitted.error).toBeUndefined();
    for (
      let i = 0;
      i < 400 &&
      !events.some((e) => e.type === "bake-status" && e.status === "done");
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      events.some((e) => e.type === "bake-status" && e.status === "done"),
    ).toBe(true);
    const real = JSON.parse(await readFile(join(repoRoot, LOCALE), "utf8"));
    expect(real.title).toBe("Baked title");
    expect(
      existsSync(join(repoRoot, changesetsDir(""), changesetId)),
    ).toBe(false);
  });

  it("reports unrepresentable edits so the caller falls back to the real write", async () => {
    const repoRoot = await makeRepo();
    const { orchestrator } = harness();
    const staged = await orchestrator.stageDirectDataEdit({
      repoRoot,
      appDir: "",
      conversationId: "c-3",
      rel: LOCALE,
      // Byte change with NO key-level difference (whitespace only).
      apply: (current) => ({ updated: `${current}\n` }),
    });
    expect(staged).toMatchObject({ unrepresentable: true });
    expect(
      existsSync(join(repoRoot, changesetsDir(""), directChangesetId("c-3"))),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conversation turn capture (main-chat tool writes).
// ---------------------------------------------------------------------------

describe("conversation turn capture (git)", () => {
  it("tool + bash writes in the conversation worktree commit and project onto the direct-edits layer; real tree untouched", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness();
    const conversationId = "c-turn";
    const changesetId = directChangesetId(conversationId);
    const workspace = (await orchestrator.ensureConversationWorkspace({
      repoRoot,
      appDir: "",
      conversationId,
    }))!;
    expect(workspace.changesetId).toBe(changesetId);
    const handle = (await orchestrator.beginConversationGitTurn({
      repoRoot,
      appDir: "",
      conversationId,
    }))!;
    // The agent "edits" a real module through a built-in tool (per-write
    // commit via the event seam)…
    await writeFile(
      join(handle.worktreeAbs, "src/Card.tsx"),
      "export function ProductCard() { return <i>chat edit</i>; }\n",
    );
    await handle.capture.noteToolEnd({ toolCallId: "w1", toolName: "write" });
    // …and mutates a locale value via BASH (nobody notes it — the finish
    // catch-all commits it; no capture machinery, bash just works).
    const before = await readFile(join(handle.worktreeAbs, LOCALE), "utf8");
    await writeFile(
      join(handle.worktreeAbs, LOCALE),
      replaceJsonStringValue(before, "title", "Chat title")!,
    );
    const original = {
      card: await readFile(join(repoRoot, "src/Card.tsx"), "utf8"),
      locale: await readFile(join(repoRoot, LOCALE), "utf8"),
    };
    const finished = await orchestrator.finishConversationGitTurn({
      repoRoot,
      appDir: "",
      conversationId,
      handle,
      sessionId: "sess-1",
      turnIndex: 2,
    });
    expect(finished.commits.length).toBeGreaterThanOrEqual(2);
    expect(finished.files.sort()).toEqual(["src/Card.tsx", LOCALE].sort());
    expect(finished.warnings).toEqual([]);
    // Real tree untouched.
    expect(await readFile(join(repoRoot, "src/Card.tsx"), "utf8")).toBe(
      original.card,
    );
    expect(await readFile(join(repoRoot, LOCALE), "utf8")).toBe(
      original.locale,
    );
    // The projected layer carries both: code as the direct alternative
    // (selected — direct edits preview immediately), data as key changes.
    const meta = parseLayerMeta(
      await readFile(join(repoRoot, changesetMetaPath("", changesetId)), "utf8"),
    )!;
    expect(meta.conversationId).toBe(conversationId);
    expect(meta.overrides["src/Card.tsx"]).toMatchObject({
      selection: DIRECT_ALT_ID,
      alternatives: [DIRECT_ALT_ID],
    });
    expect(meta.overrides[LOCALE]).toMatchObject({
      selection: DATA_ALT_ID,
      addedKeys: ["title"],
    });
    const redirects = await orchestrator.redirects(repoRoot, "");
    expect(redirects.redirects[join(repoRoot, "src/Card.tsx")]).toBe(
      join(repoRoot, altFilePath("", changesetId, DIRECT_ALT_ID, "src/Card.tsx")),
    );
    expect(
      events.some(
        (e) => e.type === "conversation-capture" && e.changesetId === changesetId,
      ),
    ).toBe(true);
    // Per-write commit linkage: the tool commit carries its trailer, the
    // final commit the turn boundary trailers.
    const log = (
      await execFileAsync(
        "git",
        ["log", "--format=%B", `refs/designbook/changesets/${changesetId}/trunk`],
        { cwd: repoRoot },
      )
    ).stdout;
    expect(log).toContain("Designbook-Tool-Call: w1");
    expect(log).toContain(`Designbook-Conversation: ${conversationId}`);
    expect(log).toContain("Designbook-Turn: sess-1/2");
  });

  it("an answer-only turn leaves no trace (no commits, no layer record)", async () => {
    const repoRoot = await makeRepo();
    const { orchestrator } = harness();
    const handle = (await orchestrator.beginConversationGitTurn({
      repoRoot,
      appDir: "",
      conversationId: "c-quiet",
    }))!;
    const finished = await orchestrator.finishConversationGitTurn({
      repoRoot,
      appDir: "",
      conversationId: "c-quiet",
      handle,
    });
    expect(finished.commits).toEqual([]);
    expect(finished.files).toEqual([]);
    const status = await orchestrator.status(repoRoot, "");
    expect(
      status.changesets.some((c) => c.id === directChangesetId("c-quiet")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rollback (G1, server-side).
// ---------------------------------------------------------------------------

describe("rollback", () => {
  it("rewinds a turn's commits on the direct trunk, re-projects, and keeps rolled-off commits sha-reachable", async () => {
    const repoRoot = await makeRepo();
    const { events, orchestrator } = harness();
    const conversationId = "c-roll";
    const changesetId = directChangesetId(conversationId);
    // Turn 1 commits an edit.
    const h1 = (await orchestrator.beginConversationGitTurn({
      repoRoot,
      appDir: "",
      conversationId,
    }))!;
    await writeFile(
      join(h1.worktreeAbs, "src/Card.tsx"),
      "export function ProductCard() { return <u>turn one</u>; }\n",
    );
    const turn1 = await orchestrator.finishConversationGitTurn({
      repoRoot,
      appDir: "",
      conversationId,
      handle: h1,
      sessionId: "s",
      turnIndex: 1,
    });
    // Turn 2 revises it.
    const h2 = (await orchestrator.beginConversationGitTurn({
      repoRoot,
      appDir: "",
      conversationId,
    }))!;
    await writeFile(
      join(h2.worktreeAbs, "src/Card.tsx"),
      "export function ProductCard() { return <u>turn two</u>; }\n",
    );
    const turn2 = await orchestrator.finishConversationGitTurn({
      repoRoot,
      appDir: "",
      conversationId,
      handle: h2,
      sessionId: "s",
      turnIndex: 2,
    });
    const altAbs = join(
      repoRoot,
      altFilePath("", changesetId, DIRECT_ALT_ID, "src/Card.tsx"),
    );
    expect(await readFile(altAbs, "utf8")).toContain("turn two");
    // Rollback to BEFORE turn 2 (its `from` boundary).
    const rolled = await orchestrator.rollback({
      repoRoot,
      appDir: "",
      changesetId,
      commit: turn2.from,
      ref: turn2.ref,
    });
    expect(rolled.error).toBeUndefined();
    expect(rolled.ref).toBe(turn2.ref);
    // The projection rewound to turn one's design.
    expect(await readFile(altAbs, "utf8")).toContain("turn one");
    expect(
      events.some((e) => e.type === "rollback" && e.changesetId === changesetId),
    ).toBe(true);
    // Rolled-off commits stay reachable by sha until gc.
    const show = (
      await execFileAsync("git", ["show", `${turn2.to}:src/Card.tsx`], {
        cwd: repoRoot,
      })
    ).stdout;
    expect(show).toContain("turn two");
    // Safety: a commit outside the changeset's branches is refused.
    const foreign = await orchestrator.rollback({
      repoRoot,
      appDir: "",
      changesetId,
      commit: "0000000000000000000000000000000000000000",
    });
    expect(foreign.error).toBeDefined();
    // The base boundary itself is a valid target (full rewind).
    const full = await orchestrator.rollback({
      repoRoot,
      appDir: "",
      changesetId,
      commit: turn1.from,
    });
    expect(full.error).toBeUndefined();
    expect(existsSync(altAbs)).toBe(false); // projection swept clean
  });
});

// ---------------------------------------------------------------------------
// Branch filtering surface.
// ---------------------------------------------------------------------------

describe("allBranches listing", () => {
  it("default hides foreign-branch layers; allBranches returns them tagged", async () => {
    const repoRoot = await makeRepo();
    // A layer left on disk by ANOTHER branch.
    const foreign: ChangesetLayer = {
      id: "foreign-1",
      pinId: "pin-foreign",
      branch: "feature/other",
      baseCommit: "c9",
      createdAt: 1,
      active: true,
      order: 1,
      baseHashes: {},
      overrides: {
        "src/Card.tsx": { selection: "v1", alternatives: ["v1"] },
      },
    };
    const metaAbs = join(repoRoot, changesetMetaPath("", "foreign-1"));
    await mkdir(join(metaAbs, ".."), { recursive: true });
    await writeFile(metaAbs, serializeLayerMeta(foreign));

    const { orchestrator } = harness();
    const status = await orchestrator.status(repoRoot, "");
    expect(status.changesets).toEqual([]);
    // Nothing resolves from a foreign layer.
    const redirects = await orchestrator.redirects(repoRoot, "");
    expect(Object.keys(redirects.redirects)).toEqual([]);

    const hidden = await orchestrator.listChangesets({
      repoRoot,
      appDir: "",
    });
    expect(hidden.changesets).toEqual([]);
    const all = await orchestrator.listChangesets({
      repoRoot,
      appDir: "",
      allBranches: true,
    });
    expect(all.branch).toBe("main");
    expect(all.changesets).toHaveLength(1);
    expect(all.changesets[0]).toMatchObject({
      id: "foreign-1",
      branch: "feature/other",
      baseCommit: "c9",
      foreign: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Data CHANGES machinery (mutations for direct layers).
// ---------------------------------------------------------------------------

describe("data changes (additions + mutations)", () => {
  it("computeDataChanges catches mutations; computeDataAdditions never did", () => {
    const base = '{"a": "one", "b": "two"}';
    const layered = '{"a": "ONE", "b": "two", "c": "three"}';
    const changes = computeDataChanges("json", base, layered);
    expect([...changes.keys()].sort()).toEqual(["a", "c"]);
  });

  it("applyDataChanges overrides existing values (json/po/cssvar) and appends new keys", () => {
    expect(
      JSON.parse(
        applyDataChanges(
          "json",
          '{"a": "one"}',
          new Map([
            ["a", JSON.stringify("ONE")],
            ["b", JSON.stringify("two")],
          ]),
        ),
      ),
    ).toEqual({ a: "ONE", b: "two" });
    const po = 'msgid "Hello"\nmsgstr "Bonjour"\n';
    const poOut = applyDataChanges("po", po, new Map([["Hello", "Salut"]]));
    expect(poOut).toContain('msgstr "Salut"');
    const css = ":root {\n  --primary: red;\n}\n";
    const cssOut = applyDataChanges(
      "cssvar",
      css,
      new Map([
        [":root --primary", "blue"],
        [":root --accent", "green"],
      ]),
    );
    expect(cssOut).toContain("--primary: blue");
    expect(cssOut).toContain("--accent: green");
  });

  it("mergeDataLayers: a layer's changed value WINS over current; same-key conflicts still surface", () => {
    const merged = mergeDataLayers({
      format: "json",
      file: "x.json",
      current: '{"title": "Hello"}',
      layers: [
        { changesetId: "d1", additions: new Map([["title", '"Howdy"']]) },
        { changesetId: "d2", additions: new Map([["title", '"Yo"']]) },
      ],
    });
    expect(JSON.parse(merged.content).title).toBe("Howdy"); // bottom-most wins
    expect(merged.conflicts).toEqual([
      { file: "x.json", key: "title", changesetIds: ["d1", "d2"] },
    ]);
  });
});
