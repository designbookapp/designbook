import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_PATH,
  buildFrameSrc,
  normalizeAppPath,
  stripFrameParam,
} from "@designbook-ui/models/frame/appFrame";

describe("normalizeAppPath", () => {
  it("adds a leading slash when missing", () => {
    expect(normalizeAppPath("trips")).toBe("/trips");
  });

  it("leaves an already-rooted path alone", () => {
    expect(normalizeAppPath("/trips/coastal-trail")).toBe(
      "/trips/coastal-trail",
    );
  });

  it("defaults empty/whitespace input to the root", () => {
    expect(normalizeAppPath("")).toBe(DEFAULT_APP_PATH);
    expect(normalizeAppPath("   ")).toBe(DEFAULT_APP_PATH);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeAppPath("  /trips  ")).toBe("/trips");
  });
});

describe("buildFrameSrc", () => {
  it("appends the guard param to a bare path", () => {
    expect(buildFrameSrc("/trips")).toBe("/trips?__designbook_frame=1");
  });

  it("normalizes a path missing its leading slash", () => {
    expect(buildFrameSrc("trips")).toBe("/trips?__designbook_frame=1");
  });

  it("preserves an existing query string", () => {
    expect(buildFrameSrc("/search?q=coastal")).toBe(
      "/search?q=coastal&__designbook_frame=1",
    );
  });

  it("defaults to the root", () => {
    expect(buildFrameSrc("/")).toBe("/?__designbook_frame=1");
    expect(buildFrameSrc("")).toBe("/?__designbook_frame=1");
  });
});

describe("stripFrameParam", () => {
  it("removes the guard param, leaving other query params intact", () => {
    expect(stripFrameParam("/trips?__designbook_frame=1")).toBe("/trips");
    expect(
      stripFrameParam("/search?q=coastal&__designbook_frame=1"),
    ).toBe("/search?q=coastal");
  });

  it("is a no-op when the param is absent", () => {
    expect(stripFrameParam("/trips")).toBe("/trips");
    expect(stripFrameParam("/trips?q=1")).toBe("/trips?q=1");
  });

  it("round-trips with buildFrameSrc", () => {
    expect(stripFrameParam(buildFrameSrc("/trips/coastal-trail"))).toBe(
      "/trips/coastal-trail",
    );
  });
});
