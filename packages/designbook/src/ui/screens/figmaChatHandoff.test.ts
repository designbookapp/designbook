/**
 * Guards for the Figma sync surfaces under the integration-plugin seam (S3):
 * the pull flow DRAFTS instead of sending — `FigmaSyncControls` hands the
 * `formatPullPrompt` text straight to the seam's `openChat` on pull success
 * (no intermediate confirm panel) and never POSTs `/api/prompt` (the user's
 * send click in the chat is the single confirm gate).
 *
 * The old expanded workbench (which wired `openChat` to its right-panel chat
 * tab) is retired with the full-view migration; the plugin-side seam is kept
 * pinned here so a future full-view integration-tab host can rewire it.
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

function readPlugin(file: string): string {
  return readFileSync(join(figmaUiDir, file), "utf8");
}

describe("figma sync surfaces", () => {
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

  // The full-view HOME for figma is now the props-panel section (the retired
  // tab's replacement). It re-satisfies the SAME pull handoff contract off the
  // section context's `openChat` seam.
  it("the props-panel section drafts pull straight into chat (no POST, no confirm panel)", () => {
    const source = readPlugin("FigmaSection.tsx");
    expect(source).not.toContain("/api/prompt");
    expect(source).not.toContain("FigmaPullPanel");
    // Pull success drafts the composed prompt into the section context's chat.
    expect(source).toMatch(/openChat\(\s*\n?\s*formatPullPrompt\(/);
    // The seam is read off the resolved section context, not a bespoke prop.
    expect(source).toContain("context");
  });
});
