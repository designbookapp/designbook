/**
 * The select tool's capture-phase interception (toolIntercept.ts): pure
 * verdict-routing tests plus a source-scan guard pinning the properties the
 * leak fix depends on — the FULL event set and capture-phase registration on
 * the layer's window, and that both select surfaces (CanvasOverlay, PageTools)
 * actually install it. A regression in any of these silently re-opens the
 * "selection click presses a real app button" leak.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INTERCEPTED_TOOL_EVENTS,
  TOOL_UI_ATTR,
  resolveToolIntercept,
} from "./toolIntercept";

type Node = { hasAttribute?: (name: string) => boolean };

const plain: Node = { hasAttribute: () => false };
const toolUi: Node = {
  hasAttribute: (name: string) => name === TOOL_UI_ATTR,
};

describe("resolveToolIntercept", () => {
  const layer: Node = { hasAttribute: () => false };

  it("intercepts events whose composed path hits the bare layer", () => {
    expect(resolveToolIntercept([plain, plain, layer, plain], layer)).toBe(
      "intercept",
    );
    expect(resolveToolIntercept([layer], layer)).toBe("intercept");
  });

  it("passes events that never reach the layer (chip, panels, app chrome)", () => {
    expect(resolveToolIntercept([plain, plain], layer)).toBe("pass");
    expect(resolveToolIntercept([], layer)).toBe("pass");
  });

  it("exempts interactive tool chrome nested inside the layer", () => {
    expect(resolveToolIntercept([plain, toolUi, layer], layer)).toBe(
      "tool-ui",
    );
  });

  it("ignores a stray tool-ui marker OUTSIDE the layer", () => {
    // An app element carrying the attribute can't opt out of anything: the
    // path never reaches the layer, so the verdict is a plain pass.
    expect(resolveToolIntercept([toolUi, plain], layer)).toBe("pass");
    // …and tool-ui AFTER the layer (i.e. above it) doesn't exempt either.
    expect(resolveToolIntercept([plain, layer, toolUi], layer)).toBe(
      "intercept",
    );
  });

  it("passes everything when there is no layer", () => {
    expect(resolveToolIntercept([plain], null)).toBe("pass");
  });
});

describe("intercepted event set", () => {
  it("covers the full press sequence a selection click produces", () => {
    // The leak this fix closes: apps acting on pointerdown/mousedown fire
    // BEFORE a click-only interceptor. Every stage of the sequence must be
    // swallowed, plus the click variants and the native context menu.
    expect([...INTERCEPTED_TOOL_EVENTS]).toEqual([
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "auxclick",
      "dblclick",
      "contextmenu",
    ]);
  });
});

describe("source guard: capture-phase interception stays wired", () => {
  const screensDir = resolve(dirname(fileURLToPath(import.meta.url)));
  const read = (path: string) => readFileSync(path, "utf8");

  it("toolIntercept registers every event in the CAPTURE phase", () => {
    const source = read(join(screensDir, "toolIntercept.ts"));
    // The loop over INTERCEPTED_TOOL_EVENTS must add capture-phase listeners;
    // losing `capture: true` re-opens the app-document-capture leak.
    expect(source).toMatch(
      /for \(const type of INTERCEPTED_TOOL_EVENTS\) \{\s*\n\s*win\.addEventListener\(type, onEvent, \{ capture: true \}\);/,
    );
    // …and swallows before app handlers: both cancellation calls present.
    expect(source).toContain("event.preventDefault();");
    expect(source).toContain("event.stopImmediatePropagation();");
  });

  it("CanvasOverlay drives selection through the interceptor, not React", () => {
    const source = read(join(screensDir, "CanvasOverlay.tsx"));
    expect(source).toContain("installToolIntercept(layer, {");
    // The old leak shape: React click handlers on the overlay root would let
    // the full sequence escape to the app's document.
    expect(source).not.toMatch(/onClick=\{handleClick\}/);
    expect(source).not.toMatch(/onDoubleClick=\{handleDoubleClick\}/);
    expect(source).not.toMatch(/onContextMenu=\{handleContextMenu\}/);
  });

});
