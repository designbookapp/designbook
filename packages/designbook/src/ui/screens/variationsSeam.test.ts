/**
 * Seam guards for the design-variations review surfaces (docs/specs/
 * design-variations.md, DECIDED). Source-level assertions in the house style
 * (figmaChatHandoff.test.ts): the vitest environment is node, so behavior is
 * pinned at the seams, not the DOM.
 *
 *   1. D1 consent: Generate POSTs `/api/variations/generate` DIRECTLY —
 *      the variations UI never drafts into chat and never touches
 *      `/api/prompt`.
 *   2. Variant cells render through the standard `PreviewCell` path and
 *      remount per `rev` (the ?t= cache-bust — per-cell HMR, no reload).
 *   3. The provider reconstructs from GET `/api/variations` (durable index)
 *      and folds SSE `variations-event`s; landings ping the file-write bus
 *      so the Changes tab refreshes.
 *   4. The Workbench mounts the provider at the composition root.
 *   5. The director brief carries the selection-context prompt block.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const screensDir = resolve(dirname(fileURLToPath(import.meta.url)));
const modelsDir = resolve(screensDir, "../models/variations");

const strip = readFileSync(join(screensDir, "VariationsStrip.tsx"), "utf8");
const provider = readFileSync(
  join(modelsDir, "VariationsProvider.tsx"),
  "utf8",
);
const detail = readFileSync(join(screensDir, "NodeDetailView.tsx"), "utf8");
const workbench = readFileSync(join(screensDir, "Workbench.tsx"), "utf8");

describe("variations seams", () => {
  it("Generate POSTs directly (D1) — no chat draft, no /api/prompt anywhere", () => {
    expect(provider).toContain('"/api/variations/generate"');
    for (const source of [strip, provider]) {
      expect(source).not.toContain("/api/prompt");
      expect(source).not.toContain("draftPromptToChat");
      expect(source).not.toContain("setChatDraft");
    }
  });

  it("the strip renders variants through PreviewCell and remounts per rev", () => {
    expect(strip).toContain("synthesizeVariantEntry(base, item)");
    // The rev key moved to MeasuredPreview (which wraps the cell): a fresh
    // rev remounts the measured subtree AND the PreviewCell import.
    expect(strip).toMatch(
      /<MeasuredPreview key=\{item\.rev\} onMeasure=\{setRenderedSize\}>\s*<PreviewCell entry=\{entry\} \/>/,
    );
  });

  it("the provider reconstructs from the durable index and folds SSE events", () => {
    expect(provider).toContain('fetch(apiUrl("/api/variations"))');
    expect(provider).toContain('addEventListener("variations-event"');
    expect(provider).toContain("applyVariationsEvent");
    // Landings nudge the Changes tab (ephemeral pi-events are not broadcast).
    expect(provider).toContain("notifyFileWritten(");
  });

  it("the workbench mounts VariationsProvider at the composition root", () => {
    expect(workbench).toContain("<VariationsProvider>");
    expect(workbench).toMatch(
      /<VariationsProvider>\s*<WorkbenchContent/,
    );
  });

  it("the detail view exposes compare as a third layout with the strip + cycler", () => {
    expect(detail).toContain('type DetailLayout = "single" | "matrix" | "compare"');
    expect(detail).toContain("<VariationsStrip");
    expect(detail).toContain("<VariationsCycler");
    expect(detail).toContain("focusedVariantEntry(");
  });

  it("the generate brief carries the selection-context prompt block", () => {
    expect(strip).toContain("buildSelectionContextBlock()");
  });

  it("strip labels render INSIDE the cell card, truncating (FIX 1)", () => {
    // FrameShell: header block inside the bordered card, before the body.
    const shell = strip.slice(
      strip.indexOf("function FrameShell"),
      strip.indexOf("function PendingSkeleton"),
    );
    expect(shell).toContain("overflow-hidden rounded-lg border");
    expect(shell).toMatch(/min-w-0 truncate[^"]*"\s*\n?\s*title=\{title\}/);
    expect(shell).toMatch(/title=\{intent\}/);
    // Body owns its overflow; footer pinned to the card bottom.
    expect(shell).toContain("relative min-h-40 flex-1 overflow-x-auto");
    expect(shell).toContain("mt-auto border-t");
    // No free-floating label layer outside the card remains.
    expect(shell).not.toContain("items-baseline gap-2");
  });

  it("the strip row is a fixed-column horizontal scroll container (FIX 1)", () => {
    expect(strip).toContain("items-stretch gap-3 overflow-x-auto");
    expect(strip).toContain("w-80 shrink-0 flex-col self-stretch");
  });

  it("empty renders are measured on the preview root and surfaced (FIX 2)", () => {
    // Layout size of [data-db-entry], not fiber rects, not client rects.
    expect(strip).toContain('el.querySelector("[data-db-entry]")');
    expect(strip).toContain("offsetWidth");
    expect(strip).not.toContain("getBoundingClientRect()");
    expect(strip).toContain('classifyRenderedSize(renderedSize) === "empty"');
    // Surfaced with failed prominence; actions stay available (no auto-iterate).
    expect(strip).toContain("copy.emptyRender");
    expect(strip).toMatch(/emptyRender \? "failed" : "normal"/);
  });

  it("the preview area HARD-CONTAINS hostile variant styling", () => {
    const shell = strip.slice(
      strip.indexOf("function FrameShell"),
      strip.indexOf("function PendingSkeleton"),
    );
    // contain:layout paint = containing block for absolute AND fixed
    // descendants + paint clip; cells grow with tall content (no max-h); wide content scrolls;
    // max-h bounds tall variants. Nothing escapes the cell.
    expect(shell).toContain("[contain:layout_paint]");
    expect(shell).toContain("relative min-h-40 flex-1 overflow-x-auto");
  });

  it("ephemeral turns inherit the chat's selected model (director + variants)", () => {
    const api = readFileSync(
      resolve(screensDir, "../../node/api/api.ts"),
      "utf8",
    );
    const helper = api.slice(
      api.indexOf("async function activeSelectedModel"),
      api.indexOf("async function runVariationTurn"),
    );
    // Peek, never spawn a session just to read its model.
    expect(helper).toContain("sessions.peek(activeSessionKey())");
    expect(helper).not.toContain("sessions.get(");
    const turn = api.slice(
      api.indexOf("async function runVariationTurn"),
      api.indexOf("const variations ="),
    );
    expect(turn).toContain("await activeSelectedModel()");
    expect(turn).toContain("await session.setModel(inheritedModel)");
    // The popover surfaces what will run.
    expect(strip).toContain('fetch(apiUrl("/api/state"))');
    expect(strip).toContain("copy.costNote(count, modelName)");
  });

  it("the intrinsic-height rule feeds forward into skill and prompt", () => {
    const skill = readFileSync(
      resolve(screensDir, "../../skills/variations/SKILL.md"),
      "utf8",
    );
    const orchestrator = readFileSync(
      resolve(screensDir, "../../node/api/variations.ts"),
      "utf8",
    );
    expect(skill).toContain("root must have intrinsic height");
    expect(orchestrator).toContain("ROOT must have intrinsic height");
  });
});
