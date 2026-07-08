import { describe, expect, it } from "vitest";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  dragPanelWidth,
  initialPanelWidth,
} from "./panelResize";

describe("clampPanelWidth", () => {
  it("passes through in-range widths, rounded", () => {
    expect(clampPanelWidth(300)).toBe(300);
    expect(clampPanelWidth(300.6)).toBe(301);
  });

  it("clamps to the min/max bounds", () => {
    expect(clampPanelWidth(0)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(PANEL_MIN_WIDTH - 1)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(PANEL_MAX_WIDTH + 1)).toBe(PANEL_MAX_WIDTH);
    expect(clampPanelWidth(10_000)).toBe(PANEL_MAX_WIDTH);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampPanelWidth(NaN)).toBe(PANEL_DEFAULT_WIDTH);
    expect(clampPanelWidth(Infinity)).toBe(PANEL_DEFAULT_WIDTH);
  });

  it("keeps the default inside the clamp range", () => {
    expect(clampPanelWidth(PANEL_DEFAULT_WIDTH)).toBe(PANEL_DEFAULT_WIDTH);
  });
});

describe("dragPanelWidth", () => {
  it("right-edge handle: dragging right widens, left narrows", () => {
    expect(dragPanelWidth(400, 100, 150, "right")).toBe(450);
    expect(dragPanelWidth(400, 100, 60, "right")).toBe(360);
  });

  it("left-edge handle: dragging left widens, right narrows", () => {
    expect(dragPanelWidth(400, 100, 50, "left")).toBe(450);
    expect(dragPanelWidth(400, 100, 140, "left")).toBe(360);
  });

  it("clamps at both ends of a drag", () => {
    expect(dragPanelWidth(400, 0, 5_000, "right")).toBe(PANEL_MAX_WIDTH);
    expect(dragPanelWidth(400, 0, -5_000, "right")).toBe(PANEL_MIN_WIDTH);
    expect(dragPanelWidth(400, 0, -5_000, "left")).toBe(PANEL_MAX_WIDTH);
    expect(dragPanelWidth(400, 0, 5_000, "left")).toBe(PANEL_MIN_WIDTH);
  });
});

describe("initialPanelWidth", () => {
  it("uses the persisted value when valid", () => {
    expect(initialPanelWidth(333)).toBe(333);
  });

  it("clamps a persisted value outside the current bounds", () => {
    expect(initialPanelWidth(1)).toBe(PANEL_MIN_WIDTH);
    expect(initialPanelWidth(9_999)).toBe(PANEL_MAX_WIDTH);
  });

  it("falls back to the default for absent/garbage values", () => {
    expect(initialPanelWidth(null)).toBe(PANEL_DEFAULT_WIDTH);
    expect(initialPanelWidth(undefined)).toBe(PANEL_DEFAULT_WIDTH);
    expect(initialPanelWidth(NaN)).toBe(PANEL_DEFAULT_WIDTH);
  });
});
