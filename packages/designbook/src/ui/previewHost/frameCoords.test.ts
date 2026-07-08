import { describe, expect, it } from "vitest";
import {
  frameLocalBoxToScreenBox,
  frameScale,
  isFrameDocumentStale,
  isWithinFrameBounds,
  screenPointToFrameLocal,
} from "./frameCoords";

describe("frameScale", () => {
  it("is 1 when the frame is unscaled (screen width == layout width)", () => {
    expect(frameScale({ x: 0, y: 0, width: 1280, height: 800 }, 1280)).toBe(1);
  });

  it("derives the canvas zoom from the rendered vs. logical width", () => {
    expect(frameScale({ x: 0, y: 0, width: 640, height: 400 }, 1280)).toBe(0.5);
  });

  it("falls back to 1 when the layout width is unmeasurable (zero)", () => {
    expect(frameScale({ x: 0, y: 0, width: 640, height: 400 }, 0)).toBe(1);
  });
});

describe("screenPointToFrameLocal", () => {
  it("subtracts the frame's screen offset at scale 1", () => {
    expect(
      screenPointToFrameLocal(
        { x: 150, y: 220 },
        { x: 100, y: 200, width: 1280, height: 800 },
        1,
      ),
    ).toEqual({ x: 50, y: 20 });
  });

  it("divides by scale so a zoomed-out frame maps back to its own logical space", () => {
    expect(
      screenPointToFrameLocal(
        { x: 100 + 320, y: 200 + 200 },
        { x: 100, y: 200, width: 640, height: 400 },
        0.5,
      ),
    ).toEqual({ x: 640, y: 400 });
  });

  it("treats a falsy scale as 1 (no divide-by-zero)", () => {
    expect(
      screenPointToFrameLocal({ x: 10, y: 10 }, { x: 0, y: 0, width: 0, height: 0 }, 0),
    ).toEqual({ x: 10, y: 10 });
  });
});

describe("isWithinFrameBounds", () => {
  it("accepts points inside the content box, inclusive of edges", () => {
    expect(isWithinFrameBounds({ x: 0, y: 0 }, 1280, 800)).toBe(true);
    expect(isWithinFrameBounds({ x: 1280, y: 800 }, 1280, 800)).toBe(true);
    expect(isWithinFrameBounds({ x: 640, y: 400 }, 1280, 800)).toBe(true);
  });

  it("rejects points outside the content box", () => {
    expect(isWithinFrameBounds({ x: -1, y: 10 }, 1280, 800)).toBe(false);
    expect(isWithinFrameBounds({ x: 10, y: -1 }, 1280, 800)).toBe(false);
    expect(isWithinFrameBounds({ x: 1281, y: 10 }, 1280, 800)).toBe(false);
    expect(isWithinFrameBounds({ x: 10, y: 801 }, 1280, 800)).toBe(false);
  });
});

describe("frameLocalBoxToScreenBox", () => {
  it("is a no-op translate at scale 1", () => {
    expect(
      frameLocalBoxToScreenBox(
        { x: 20, y: 30, width: 100, height: 40 },
        { x: 100, y: 200, width: 1280, height: 800 },
        1,
      ),
    ).toEqual({ x: 120, y: 230, width: 100, height: 40 });
  });

  it("scales the box and its offset together when the frame is zoomed", () => {
    expect(
      frameLocalBoxToScreenBox(
        { x: 100, y: 100, width: 200, height: 50 },
        { x: 10, y: 10, width: 640, height: 400 },
        0.5,
      ),
    ).toEqual({ x: 60, y: 60, width: 100, height: 25 });
  });

  it("round-trips with screenPointToFrameLocal's top-left corner", () => {
    const frameScreenRect = { x: 40, y: 60, width: 384, height: 240 };
    const scale = frameScale(frameScreenRect, 1280);
    const local = screenPointToFrameLocal({ x: 100, y: 120 }, frameScreenRect, scale);
    const box = frameLocalBoxToScreenBox(
      { x: local.x, y: local.y, width: 0, height: 0 },
      frameScreenRect,
      scale,
    );
    expect(box.x).toBeCloseTo(100);
    expect(box.y).toBeCloseTo(120);
  });
});

describe("isFrameDocumentStale", () => {
  it("is false when the generation is unchanged", () => {
    expect(isFrameDocumentStale(3, 3)).toBe(false);
  });

  it("is true once the frame has navigated/reloaded (generation bumped)", () => {
    expect(isFrameDocumentStale(3, 4)).toBe(true);
  });
});
