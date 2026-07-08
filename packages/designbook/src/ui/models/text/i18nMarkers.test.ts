import { afterEach, describe, expect, it } from "vitest";
import {
  containsMarkerChars,
  decodeMarker,
  designMarkerPostProcessor,
  encodeMarker,
  setMarkingActive,
  stripMarkers,
} from "@designbook-ui/models/text/i18nMarkers";

describe("encodeMarker / decodeMarker", () => {
  it("round-trips index 0", () => {
    const encoded = encodeMarker(0);
    expect(decodeMarker(encoded)).toBe(0);
  });

  it("round-trips small indices", () => {
    for (const index of [1, 2, 3, 4, 5, 10, 15, 16]) {
      const encoded = encodeMarker(index);
      expect(decodeMarker(encoded)).toBe(index);
    }
  });

  it("round-trips large indices", () => {
    for (const index of [100, 255, 1000, 4096]) {
      const encoded = encodeMarker(index);
      expect(decodeMarker(encoded)).toBe(index);
    }
  });

  it("returns undefined for text without markers", () => {
    expect(decodeMarker("hello world")).toBeUndefined();
    expect(decodeMarker("")).toBeUndefined();
  });

  it("returns undefined for negative index", () => {
    expect(encodeMarker(-1)).toBe("");
  });

  it("decodes marker embedded in regular text", () => {
    const marker = encodeMarker(42);
    const text = `Some translated string${marker}`;
    expect(decodeMarker(text)).toBe(42);
  });

  it("decodes the last marker when multiple are present", () => {
    const marker1 = encodeMarker(10);
    const marker2 = encodeMarker(20);
    const text = `Part1${marker1} Part2${marker2}`;
    expect(decodeMarker(text)).toBe(20);
  });
});

describe("stripMarkers", () => {
  it("removes markers from text", () => {
    const marker = encodeMarker(42);
    const text = `Hello world${marker}`;
    expect(stripMarkers(text)).toBe("Hello world");
  });

  it("preserves text without markers", () => {
    expect(stripMarkers("plain text")).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(stripMarkers("")).toBe("");
  });

  it("removes multiple markers", () => {
    const marker1 = encodeMarker(5);
    const marker2 = encodeMarker(10);
    const text = `Hello${marker1} world${marker2}`;
    expect(stripMarkers(text)).toBe("Hello world");
  });

  it("round-trips: decode(strip(marked)) is undefined", () => {
    const marker = encodeMarker(7);
    const text = `Translated${marker}`;
    const stripped = stripMarkers(text);
    expect(decodeMarker(stripped)).toBeUndefined();
  });
});

describe("containsMarkerChars", () => {
  it("returns true when marker chars are present", () => {
    const marker = encodeMarker(1);
    expect(containsMarkerChars(marker)).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(containsMarkerChars("Hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(containsMarkerChars("")).toBe(false);
  });
});

describe("designMarkerPostProcessor gating (setMarkingActive)", () => {
  afterEach(() => setMarkingActive(true)); // restore default for other suites

  const process = (value: string) =>
    designMarkerPostProcessor.process(value, "greeting.title", { ns: "app" });

  it("appends a marker while marking is active (default)", () => {
    setMarkingActive(true);
    const out = process("Welcome back");
    expect(out).not.toBe("Welcome back");
    expect(containsMarkerChars(out)).toBe(true);
  });

  it("passes the value through untouched when marking is off", () => {
    setMarkingActive(false);
    expect(process("Welcome back")).toBe("Welcome back");
  });
});
