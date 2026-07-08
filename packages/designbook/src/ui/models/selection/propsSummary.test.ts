import { describe, expect, it } from "vitest";
import { summarizeProps } from "./propsSummary";

describe("summarizeProps", () => {
  it("formats primitives and preserves prop order", () => {
    const rows = summarizeProps({
      label: "Buy now",
      count: 3,
      disabled: false,
      onClick: () => {},
    });
    expect(rows.map((row) => row.name)).toEqual([
      "label",
      "count",
      "disabled",
      "onClick",
    ]);
    expect(rows[0]).toEqual({
      name: "label",
      value: '"Buy now"',
      kind: "primitive",
    });
    expect(rows[1].value).toBe("3");
    expect(rows[2].value).toBe("false");
    expect(rows[3]).toEqual({ name: "onClick", value: "ƒ()", kind: "opaque" });
  });

  it("skips children", () => {
    const rows = summarizeProps({ children: "text", size: "sm" });
    expect(rows.map((row) => row.name)).toEqual(["size"]);
  });

  it("shows null / undefined explicitly", () => {
    const rows = summarizeProps({ a: null, b: undefined });
    expect(rows[0].value).toBe("null");
    expect(rows[1].value).toBe("undefined");
  });

  it("marks react elements (and element arrays) opaque", () => {
    const element = { $$typeof: Symbol.for("react.element"), type: "div" };
    const rows = summarizeProps({ icon: element, slots: [element] });
    expect(rows[0]).toEqual({ name: "icon", value: "<element>", kind: "opaque" });
    expect(rows[1]).toEqual({
      name: "slots",
      value: "<elements>",
      kind: "opaque",
    });
  });

  it("ellipsizes long values", () => {
    const rows = summarizeProps({ blob: "x".repeat(500) });
    expect(rows[0].value.length).toBeLessThanOrEqual(120);
    expect(rows[0].value.endsWith("…")).toBe(true);
  });

  it("survives circular objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rows = summarizeProps({ data: circular, list: [circular] });
    expect(rows[0]).toEqual({ name: "data", value: "{…}", kind: "opaque" });
    expect(rows[1]).toEqual({ name: "list", value: "[…]", kind: "opaque" });
  });

  it("serializes plain objects and arrays", () => {
    const rows = summarizeProps({ tags: ["a", "b"], opts: { x: 1 } });
    expect(rows[0]).toEqual({
      name: "tags",
      value: '["a","b"]',
      kind: "opaque",
    });
    expect(rows[1].value).toBe('{"x":1}');
  });
});
