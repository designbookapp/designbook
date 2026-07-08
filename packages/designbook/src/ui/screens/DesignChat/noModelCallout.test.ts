/**
 * Guards for the no-model setup callout: when the server has no provider
 * credential (session comes up modelless and /api/models is empty), the chat
 * footer must swap the prompt input for a setup callout with a retry path —
 * and the retry must actually work, which requires the server to re-read
 * `~/.pi/agent/auth.json` when it builds a new session.
 *
 * Source-level assertions, matching the repo's other node-based UI guards
 * (figmaChatHandoff.test.ts, previewHostSeam.test.ts).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = resolve(dirname(fileURLToPath(import.meta.url)));

const designChat = readFileSync(join(here, "DesignChat.tsx"), "utf8");
const api = readFileSync(
  resolve(here, "../../../node/api/api.ts"),
  "utf8",
);

describe("no-model setup callout", () => {
  it("gates the prompt form on needsModelSetup", () => {
    // Callout requires BOTH a modelless session and an empty model list —
    // auth-present-but-model-missing keeps the input (model select recovers).
    expect(designChat).toMatch(
      /needsModelSetup\s*=\s*\n?\s*state !== undefined && !state\.model && models\.length === 0/,
    );
    // The footer renders the callout INSTEAD of the form.
    expect(designChat).toMatch(
      /\{needsModelSetup \? \([\s\S]*?chat-model-setup[\s\S]*?\) : \([\s\S]*?<form onSubmit=\{submitPrompt\}>/,
    );
  });

  it("callout offers both recovery paths and a retry", () => {
    expect(designChat).toContain("npx pi");
    expect(designChat).toContain("ANTHROPIC_API_KEY");
    // Retry = new session (server re-reads auth) + refreshed model list.
    const retry = designChat.match(
      /async function retryModelSetup\(\)[\s\S]*?\n {2}\}/,
    )?.[0];
    expect(retry, "DesignChat must define retryModelSetup").toBeTruthy();
    expect(retry).toContain("startNewConversation()");
    expect(retry).toContain("fetchModels()");
  });

  it("server re-reads auth.json on every session build (makes retry work)", () => {
    const createSession = api.match(
      /async function createSession\(\)[\s\S]*?\n {2}\}/,
    )?.[0];
    expect(createSession, "api.ts must define createSession").toBeTruthy();
    expect(createSession).toContain("authStorage.reload()");
  });
});
