import { describe, expect, it } from "vitest";
import { findLiteralMatch, replaceLiteral } from "./sourceLiteral";

describe("findLiteralMatch", () => {
  it("matches a unique literal and reports its 1-based line", () => {
    const source = [
      "function Card() {",
      "  return <button>Add to cart</button>;",
      "}",
    ].join("\n");
    const match = findLiteralMatch(source, "Add to cart");
    expect(match?.line).toBe(2);
    expect(match?.matched).toBe("Add to cart");
  });

  it("returns null when the literal occurs more than once", () => {
    const source = [
      "const a = <span>Save</span>;",
      "const b = <span>Save</span>;",
    ].join("\n");
    expect(findLiteralMatch(source, "Save")).toBeNull();
  });

  it("returns null when the literal is absent", () => {
    const source = "const a = <span>Hello</span>;";
    expect(findLiteralMatch(source, "Goodbye")).toBeNull();
  });

  it("matches whitespace-collapsed JSX text spread across lines", () => {
    const source = [
      "<p>",
      "  Add",
      "  to cart",
      "</p>",
    ].join("\n");
    // Rendered text collapses to "Add to cart"; source has newlines/indent.
    const match = findLiteralMatch(source, "Add to cart");
    expect(match).not.toBeNull();
    expect(match?.line).toBe(2);
    expect(match?.matched).toContain("Add");
  });

  it("returns null for an empty/whitespace literal", () => {
    expect(findLiteralMatch("anything", "   ")).toBeNull();
  });

  it("returns null when a collapsed match is ambiguous", () => {
    // Neither line matches "Add to cart" exactly (double spaces), so both fall
    // to the whitespace-collapsed matcher — two hits, so it's not safe to edit.
    const source = ["<a>Add  to  cart</a>", "<b>Add  to  cart</b>"].join("\n");
    expect(findLiteralMatch(source, "Add to cart")).toBeNull();
  });
});

describe("replaceLiteral", () => {
  it("replaces the unique occurrence", () => {
    const source = "return <button>Add to cart</button>;";
    expect(replaceLiteral(source, "Add to cart", "Buy now")).toBe(
      "return <button>Buy now</button>;",
    );
  });

  it("replaces a whitespace-collapsed occurrence with the exact new text", () => {
    const source = ["<p>", "  Add", "  to cart", "</p>"].join("\n");
    const result = replaceLiteral(source, "Add to cart", "Buy now");
    expect(result).toBe(["<p>", "  Buy now", "</p>"].join("\n"));
  });

  it("returns null when not uniquely matchable", () => {
    const source = "<a>Save</a><b>Save</b>";
    expect(replaceLiteral(source, "Save", "Store")).toBeNull();
  });
});
