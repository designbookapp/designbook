/**
 * Guards for the Figma sync surfaces under the integration-plugin seam (S3):
 *
 *   1. the on-canvas sync controls are GONE — `NodeDetailView` must not render
 *      `FigmaSyncControls` (the figma integration tab is their only home);
 *   2. the pull flow DRAFTS instead of sending — `FigmaSyncControls` hands the
 *      `formatPullPrompt` text straight to the seam's `openChat` on pull
 *      success (no intermediate confirm panel) and never POSTs `/api/prompt`
 *      (the user's send click in the chat tab is the single confirm gate);
 *   3. the workbench renders integration tabs GENERICALLY (no direct
 *      FigmaPanel import) and wires `PluginScreenProps.openChat` to the chat
 *      draft + reveal (`draftPromptToChat` -> `setChatDraft` /
 *      `openRightTab("chat")`).
 *
 * Source-level assertions, matching the repo's other node-based UI guards
 * (apiUrlSeam.test.ts, previewHostSeam.test.ts) — the vitest environment is
 * `node`, so component behavior is pinned at the seam, not the DOM.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const screensDir = resolve(dirname(fileURLToPath(import.meta.url)));
const figmaUiDir = resolve(screensDir, "../../plugins/figma/ui");

function read(file: string): string {
  return readFileSync(join(screensDir, file), "utf8");
}

function readPlugin(file: string): string {
  return readFileSync(join(figmaUiDir, file), "utf8");
}

describe("figma sync surfaces", () => {
  it("NodeDetailView no longer renders the on-canvas Figma sync controls", () => {
    const source = read("NodeDetailView.tsx");
    expect(source).not.toContain("FigmaSyncControls");
    expect(source).not.toContain("onOpenChat");
  });

  it("pull success drafts the prompt straight into chat (no confirm panel, no POST)", () => {
    const source = readPlugin("FigmaSyncControls.tsx");
    // No auto-send and no second gate: the pull handler must not talk to
    // /api/prompt, and there is no intermediate confirm panel.
    expect(source).not.toContain("/api/prompt");
    expect(source).not.toContain("FigmaPullPanel");
    // Pull success hands the composed prompt to the seam's openChat directly.
    expect(source).toMatch(/openChat\(formatPullPrompt\(/);
  });

  it("the figma tab threads the openChat seam down to the sync controls", () => {
    for (const file of ["FigmaPanel.tsx", "FigmaSyncControls.tsx"]) {
      expect(readPlugin(file), file).toContain("openChat");
    }
  });

  it("the workbench drafts into the chat tab (set draft + reveal, no send)", () => {
    const source = read("Workbench.tsx");
    const handler = source.match(
      /function draftPromptToChat\([\s\S]*?\n {2}\}/,
    )?.[0];
    expect(handler, "Workbench must define draftPromptToChat").toBeTruthy();
    expect(handler).toContain("setChatDraft(");
    expect(handler).toContain('openRightTab("chat")');
    expect(handler).not.toContain("fetch(");
    // The seam handoff: openChat drafts through the same gate.
    const openChat = source.match(
      /function openChatFromIntegration\([\s\S]*?\n {2}\}/,
    )?.[0];
    expect(openChat, "Workbench must define openChatFromIntegration").toBeTruthy();
    expect(openChat).toContain("draftPromptToChat(");
    expect(openChat).not.toContain("fetch(");
  });

  it("the workbench renders integration tabs generically (no FigmaPanel import)", () => {
    const source = read("Workbench.tsx");
    expect(source).not.toContain("FigmaPanel");
    // The generic screen render receives the full PluginScreenProps seam.
    expect(source).toMatch(
      /<activeIntegrationTab\.Screen[\s\S]*?openChat=\{openChatFromIntegration\}/,
    );
    expect(source).toMatch(/tokenSources=\{tokenSources\}/);
  });
});
