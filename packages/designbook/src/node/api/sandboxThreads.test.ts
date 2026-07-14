/**
 * Chat-history threads tests (UX v3 U2): ephemeral filtering, title
 * derivation (context-block strip), listing against REAL SessionManager
 * fixtures in a temp session dir, and the transcript read's containment.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  EPHEMERAL_SESSION_SUBDIR,
  chatThreadTitle,
  isEphemeralTranscript,
  listChatThreads,
  readChatTranscript,
} from "./sandboxThreads.ts";

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function makeDirs(): Promise<{ cwd: string; sessionDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "db-threads-"));
  cleanups.push(root);
  return { cwd: join(root, "repo"), sessionDir: join(root, "sessions") };
}

/** Author a real JSONL session with the given messages. */
function writeSession(
  cwd: string,
  sessionDir: string,
  messages: Array<{ role: "user" | "assistant"; text: string }>,
): string {
  const manager = SessionManager.create(cwd, sessionDir);
  for (const message of messages) {
    manager.appendMessage({
      role: message.role,
      content: [{ type: "text", text: message.text }],
      timestamp: Date.now(),
    } as never);
  }
  return manager.getSessionFile()!;
}

describe("isEphemeralTranscript", () => {
  it("hides designbook's machine-turn prompts, keeps real chats", () => {
    for (const opener of [
      "You are the design DIRECTOR for a variation run on the component \"X\".",
      "Create ONE design variant of the component \"X\".",
      "Create ONE design variation of the designbook component \"x\".",
      "Propose 3 DISTINCT visual design directions for a variation exploration…",
      "Designer request on the live component \"X\" (source file: y):",
      "A designer selected the live component \"X\" in their running app and wrote:",
      "The designer selected the live component \"X\" (source file: y) in their running app and says:",
      "Title this design request in 3-6 words.",
      "Adopt a sandbox design variant into the real source: …",
    ]) {
      expect(isEphemeralTranscript(opener), opener).toBe(true);
    }
    expect(isEphemeralTranscript("make the hero tagline more playful")).toBe(
      false,
    );
    expect(isEphemeralTranscript("Can you propose a better name?")).toBe(false);
  });
});

describe("chatThreadTitle", () => {
  it("strips the canvas-context block down to the real request", () => {
    const stored = [
      "Selected canvas node context:",
      "- component: ProductCard",
      "- file: src/Card.tsx",
      "",
      "User request:",
      "make the badge pop more",
    ].join("\n");
    expect(chatThreadTitle(stored)).toBe("make the badge pop more");
  });

  it("plain messages: first line, capped", () => {
    expect(chatThreadTitle("hello there\nsecond line")).toBe("hello there");
    expect(chatThreadTitle("x".repeat(100)).length).toBeLessThanOrEqual(64);
    expect(chatThreadTitle("   ")).toBe("Conversation");
  });
});

describe("listChatThreads", () => {
  it("lists real chats (ephemeral filtered), tags the current one", async () => {
    const { cwd, sessionDir } = await makeDirs();
    const chatFile = writeSession(cwd, sessionDir, [
      { role: "user", text: "make the hero pop" },
      { role: "assistant", text: "Done." },
    ]);
    writeSession(cwd, sessionDir, [
      { role: "user", text: "You are the design DIRECTOR for a variation run on the component \"X\"." },
      { role: "assistant", text: "[]" },
    ]);
    // NOTE: the SDK only flushes a session to disk once it has an ASSISTANT
    // message — a user-only draft session has no transcript yet.
    const currentFile = writeSession(cwd, sessionDir, [
      { role: "user", text: "current conversation" },
      { role: "assistant", text: "Hi." },
    ]);

    const threads = await listChatThreads({
      cwd,
      sessionDir,
      currentSessionFile: currentFile,
    });
    expect(threads.length).toBe(2);
    const titles = threads.map((thread) => thread.title).sort();
    expect(titles).toEqual(["current conversation", "make the hero pop"]);
    const current = threads.find((thread) => thread.current)!;
    expect(current.path).toBe(currentFile);
    const past = threads.find((thread) => !thread.current)!;
    expect(past.path).toBe(chatFile);
    expect(past.messageCount).toBeGreaterThan(0);
    expect(past.lastActivityAt).toBeGreaterThan(0);
  });
});

describe("readChatTranscript", () => {
  it("reads a listed transcript; contains paths to the session store", async () => {
    const { cwd, sessionDir } = await makeDirs();
    const file = writeSession(cwd, sessionDir, [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
    const ok = readChatTranscript({ cwd, sessionDir, path: file });
    expect(ok.error).toBeUndefined();
    expect((ok.messages ?? []).length).toBe(2);

    // Outside the store → rejected (client-reachable route).
    expect(
      readChatTranscript({ cwd, sessionDir, path: "/etc/passwd" }).error,
    ).toBeDefined();
    expect(
      readChatTranscript({
        cwd,
        sessionDir,
        path: join(sessionDir, "../outside.jsonl"),
      }).error,
    ).toBeDefined();
    // The ephemeral subdir stays invisible even by direct path.
    expect(
      readChatTranscript({
        cwd,
        sessionDir,
        path: join(sessionDir, EPHEMERAL_SESSION_SUBDIR, "x.jsonl"),
      }).error,
    ).toBeDefined();
  });
});
