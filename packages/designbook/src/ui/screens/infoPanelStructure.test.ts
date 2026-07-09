/**
 * Structure guards for the polished Info panel (PREVIEW — docs/specs/
 * selection-context.md). Source-level assertions in the repo's node-based UI
 * style (noModelCallout.test.ts, figmaChatHandoff.test.ts): the wireframe's
 * per-section shapes must stay wired — bordered section cards, render-context
 * chips, i18n keyed rows + a warning hardcoded summary, a context-scope summary
 * with sampled values behind a disclosure — all from existing --tool-* tokens.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = resolve(dirname(fileURLToPath(import.meta.url)));
const infoPanel = readFileSync(join(here, "InfoPanel.tsx"), "utf8");

describe("Info panel section cards", () => {
  it("renders each contribution as a bordered, collapsible section card", () => {
    expect(infoPanel).toMatch(/rounded-lg border/);
    expect(infoPanel).toContain('data-testid={`info-section-${contribution.source}`}');
    // Header: tiny uppercase tracked title + faint mono source tag.
    expect(infoPanel).toMatch(/text-\[10px\][^"]*uppercase/);
    expect(infoPanel).toMatch(/aria-expanded=\{open\}/);
  });

  it("persists collapse state per section for the session (module-level map)", () => {
    expect(infoPanel).toContain("const collapsedSections = new Map<string, boolean>()");
  });

  it("dispatches body layout by contributor source", () => {
    expect(infoPanel).toContain('case "render-context":');
    expect(infoPanel).toContain('case "i18n":');
    expect(infoPanel).toContain('case "context-scope":');
  });

  it("renders render-context values as rounded-full chips", () => {
    expect(infoPanel).toMatch(/rounded-full border/);
    expect(infoPanel).toContain("toRenderChip");
  });

  it("tints the i18n hardcoded summary with the --tool-hardcoded token", () => {
    expect(infoPanel).toContain('data-testid="info-i18n-hardcoded"');
    expect(infoPanel).toMatch(/tool-hardcoded/);
    expect(infoPanel).toContain("TriangleAlertIcon");
  });

  it("shows a context-scope summary with sampled values behind a disclosure", () => {
    expect(infoPanel).toContain("contextScopeSummary");
    expect(infoPanel).toContain("in scope · reads");
    expect(infoPanel).toMatch(/showValues/);
  });
});
