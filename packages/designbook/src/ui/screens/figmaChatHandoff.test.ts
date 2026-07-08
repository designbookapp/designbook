/**
 * Guards for the Figma sync surfaces after the left-rail Figma tab landed:
 *
 *   1. the on-canvas sync controls are GONE — `NodeDetailView` must not render
 *      `FigmaSyncControls` (the Figma tab / `FigmaPanel` is their only home);
 *   2. the pull flow DRAFTS instead of sending — `FigmaSyncControls` hands the
 *      `formatPullPrompt` text straight to `onAddToChat` on pull success (no
 *      intermediate confirm panel) and never POSTs `/api/prompt` (the user's
 *      send click in the chat tab is the single confirm gate);
 *   3. the workbench wires that handoff to the chat draft + reveals the chat
 *      tab (`draftPromptToChat` -> `setChatDraft` / `openRightTab("chat")`).
 *
 * Source-level assertions, matching the repo's other node-based UI guards
 * (apiUrlSeam.test.ts, previewHostSeam.test.ts) — the vitest environment is
 * `node`, so component behavior is pinned at the seam, not the DOM.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const screensDir = resolve(dirname(fileURLToPath(import.meta.url)));

function read(file: string): string {
  return readFileSync(join(screensDir, file), "utf8");
}

describe("figma sync surfaces", () => {
  it("NodeDetailView no longer renders the on-canvas Figma sync controls", () => {
    const source = read("NodeDetailView.tsx");
    expect(source).not.toContain("FigmaSyncControls");
    expect(source).not.toContain("onOpenChat");
  });

  it("pull success drafts the prompt straight into chat (no confirm panel, no POST)", () => {
    const source = read("FigmaSyncControls.tsx");
    // No auto-send and no second gate: the pull handler must not talk to
    // /api/prompt, and the intermediate FigmaPullPanel is gone.
    expect(source).not.toContain("/api/prompt");
    expect(source).not.toContain("FigmaPullPanel");
    expect(existsSync(join(screensDir, "FigmaPullPanel.tsx"))).toBe(false);
    // Pull success hands the composed prompt to the draft seam directly.
    expect(source).toMatch(/onAddToChat\(formatPullPrompt\(/);
  });

  it("the Figma tab threads the draft seam down to the sync controls", () => {
    for (const file of ["FigmaPanel.tsx", "FigmaSyncControls.tsx"]) {
      expect(read(file), file).toContain("onAddToChat");
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
    // The Figma tab gets the handoff.
    expect(source).toMatch(/<FigmaPanel[\s\S]*?onAddToChat=\{draftPromptToChat\}/);
  });
});
