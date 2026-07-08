import { describe, expect, it } from "vitest";
import { shouldBailAsFrame } from "./frameGuard";

describe("shouldBailAsFrame", () => {
  it("bails when the query param is present, regardless of framing", () => {
    expect(
      shouldBailAsFrame({
        search: "?__designbook_frame=1",
        isFramed: false,
        topHasMarker: undefined,
      }),
    ).toBe(true);
  });

  it("bails when framed under a marked top window", () => {
    expect(
      shouldBailAsFrame({ search: "", isFramed: true, topHasMarker: true }),
    ).toBe(true);
  });

  it("does not bail for the top-level window (not framed)", () => {
    expect(
      shouldBailAsFrame({ search: "", isFramed: false, topHasMarker: true }),
    ).toBe(false);
  });

  it("does not bail when framed but the parent has no marker", () => {
    expect(
      shouldBailAsFrame({ search: "", isFramed: true, topHasMarker: false }),
    ).toBe(false);
  });

  it("does not bail on a cross-origin parent (marker unreadable)", () => {
    expect(
      shouldBailAsFrame({ search: "", isFramed: true, topHasMarker: undefined }),
    ).toBe(false);
  });

  it("ignores an unrelated query string", () => {
    expect(
      shouldBailAsFrame({
        search: "?foo=bar&__designbook_frame=0",
        isFramed: false,
        topHasMarker: undefined,
      }),
    ).toBe(false);
  });
});
