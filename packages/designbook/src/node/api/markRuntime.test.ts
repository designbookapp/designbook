import { describe, expect, it } from "vitest";
import { resolveMarkHost } from "./markRuntime";

describe("resolveMarkHost", () => {
  it("prefers the local hook when present, regardless of framing", () => {
    expect(
      resolveMarkHost({ hasLocalMark: true, isFramed: false, topHasMark: undefined }),
    ).toBe("local");
    expect(
      resolveMarkHost({ hasLocalMark: true, isFramed: true, topHasMark: true }),
    ).toBe("local");
  });

  it("falls back to the top window when framed and the parent has a mark hook", () => {
    expect(
      resolveMarkHost({ hasLocalMark: false, isFramed: true, topHasMark: true }),
    ).toBe("top");
  });

  it("stays passthrough when not framed and no local hook exists", () => {
    expect(
      resolveMarkHost({ hasLocalMark: false, isFramed: false, topHasMark: undefined }),
    ).toBe("none");
  });

  it("stays passthrough when framed but the parent has no mark hook", () => {
    expect(
      resolveMarkHost({ hasLocalMark: false, isFramed: true, topHasMark: false }),
    ).toBe("none");
  });

  it("stays passthrough on a cross-origin parent (unreadable, not a match)", () => {
    expect(
      resolveMarkHost({ hasLocalMark: false, isFramed: true, topHasMark: undefined }),
    ).toBe("none");
  });
});
