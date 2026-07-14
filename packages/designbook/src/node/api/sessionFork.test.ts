/**
 * G4 chat forking: boundary resolution (forkSliceLeaf) + the REAL
 * SessionManager slice (`createBranchedSession`) it feeds — a park-fork's
 * "fork the chat" is exactly these two steps, so this suite is the
 * injectable proof (it also documents the mechanism Resume will reuse).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forkSliceLeaf } from "./sessionFork.ts";

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "db-fork-"));
  cleanups.push(dir);
  return dir;
}

/** A real two-turn session: u1/a1 then u2/a2. Returns per-turn leaf ids. */
async function makeSession() {
  const dir = await tempDir();
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({ role: "user", content: "turn one prompt" });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "turn one answer" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as never);
  const turn1Leaf = manager.getLeafId()!;
  manager.appendMessage({ role: "user", content: "turn two prompt" });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "turn two answer" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as never);
  return { manager, turn1Leaf };
}

describe("forkSliceLeaf", () => {
  it("prefers the turn record's recorded leaf", async () => {
    const { manager, turn1Leaf } = await makeSession();
    expect(
      forkSliceLeaf(manager, "sess/1", [{ turn: "sess/1", leaf: turn1Leaf }]),
    ).toBe(turn1Leaf);
  });

  it("falls back to counting user prompts (entry before prompt n+1)", async () => {
    const { manager, turn1Leaf } = await makeSession();
    // No leaf on the record — turn 1's boundary = the entry before the
    // SECOND user message, i.e. turn 1's assistant answer.
    expect(forkSliceLeaf(manager, "sess/1", [{ turn: "sess/1" }])).toBe(
      turn1Leaf,
    );
  });

  it("slices at the current leaf when the turn is unknown", async () => {
    const { manager } = await makeSession();
    expect(forkSliceLeaf(manager, undefined, [])).toBe(manager.getLeafId());
  });
});

describe("createBranchedSession (the real slice)", () => {
  it("writes a NEW session containing only turn 1, linked to its parent", async () => {
    const { manager, turn1Leaf } = await makeSession();
    const parentFile = manager.getSessionFile()!;
    const parentSessionId = manager.getSessionId();
    // NOTE: createBranchedSession SWITCHES the calling manager onto the new
    // file — api.ts opens a throwaway manager for exactly this reason.
    const newFile = manager.createBranchedSession(turn1Leaf)!;
    expect(newFile).not.toBe(parentFile);

    const forked = SessionManager.open(newFile);
    // Fresh identity, parent linkage in the header (SessionInfo surfaces it).
    expect(forked.getSessionId()).not.toBe(parentSessionId);
    expect(forked.getHeader()?.parentSession).toBe(parentFile);
    // Only the turn-1 path came across.
    const texts = forked
      .buildSessionContext()
      .messages.map((message) => JSON.stringify(message));
    expect(texts.join("\n")).toContain("turn one prompt");
    expect(texts.join("\n")).toContain("turn one answer");
    expect(texts.join("\n")).not.toContain("turn two");
    // The parent transcript is untouched (still both turns).
    const parentTexts = SessionManager.open(parentFile)
      .buildSessionContext()
      .messages.map((message) => JSON.stringify(message))
      .join("\n");
    expect(parentTexts).toContain("turn two prompt");
  });
});
