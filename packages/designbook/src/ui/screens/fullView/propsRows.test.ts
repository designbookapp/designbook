/**
 * Props inspector row model: schema/runtime merge, unpassed-optional handling,
 * kind inference, and read-only value previews.
 */

import { describe, expect, it } from "vitest";
import { buildRows, formatPreview, inferKind } from "./propsRows.ts";
import type { PropDescriptor, SchemaState } from "./propsRows.ts";

function ready(props: PropDescriptor[]): SchemaState {
  return { status: "ready", props };
}

const SCHEMA: PropDescriptor[] = [
  { name: "title", typeText: "string", kind: "string", required: true },
  {
    name: "variant",
    typeText: "CardVariant",
    kind: "enum",
    options: ["solid", "outline"],
    required: false,
    defaultValue: "solid",
  },
  { name: "featured", typeText: "boolean", kind: "boolean", required: false },
  { name: "onSelect", typeText: "() => void", kind: "function", required: false },
];

describe("buildRows", () => {
  it("merges schema order + kinds with runtime values", () => {
    const rows = buildRows(ready(SCHEMA), { title: "Kyoto", featured: true }, {});
    expect(rows.map((r) => r.name)).toEqual([
      "title",
      "variant",
      "featured",
      "onSelect",
    ]);
    expect(rows[0]).toMatchObject({ value: "Kyoto", passed: true });
    // Unpassed optional prop → not passed, carries its default.
    expect(rows[1]).toMatchObject({ passed: false, defaultValue: "solid" });
    expect(rows[2]).toMatchObject({ value: true, passed: true });
  });

  it("applies local edits over runtime values", () => {
    const rows = buildRows(
      ready(SCHEMA),
      { title: "Kyoto" },
      { title: "Osaka", variant: "outline" },
    );
    expect(rows[0].value).toBe("Osaka");
    expect(rows[1]).toMatchObject({ value: "outline", passed: true });
  });

  it("appends runtime props not in the typed surface", () => {
    const rows = buildRows(ready(SCHEMA), { title: "K", extra: 7 }, {});
    const extra = rows.find((r) => r.name === "extra");
    expect(extra).toMatchObject({ kind: "number", value: 7, passed: true });
  });

  it("never emits a children row", () => {
    const rows = buildRows(ready(SCHEMA), { title: "K", children: "x" }, {});
    expect(rows.some((r) => r.name === "children")).toBe(false);
  });

  it("falls back to runtime keys when the schema is not ready", () => {
    const rows = buildRows({ status: "loading" }, { a: "x", b: 2 }, {});
    expect(rows.map((r) => r.name).sort()).toEqual(["a", "b"]);
    expect(rows.every((r) => r.passed)).toBe(true);
  });
});

describe("inferKind", () => {
  it("classifies primitives, functions, elements, objects", () => {
    expect(inferKind("s")).toBe("string");
    expect(inferKind(3)).toBe("number");
    expect(inferKind(true)).toBe("boolean");
    expect(inferKind(() => {})).toBe("function");
    expect(inferKind({ $$typeof: Symbol.for("react.element") })).toBe("node");
    expect(inferKind({ a: 1 })).toBe("object");
  });
});

describe("formatPreview", () => {
  it("previews functions, elements, arrays, objects", () => {
    expect(formatPreview(function foo() {})).toBe("ƒ foo()");
    expect(formatPreview({ $$typeof: Symbol(), type: "div" })).toBe("<div />");
    expect(formatPreview([1, 2, 3])).toBe("[…] (3)");
    expect(formatPreview({ a: 1 })).toBe('{"a":1}');
    expect(formatPreview(null)).toBe("null");
  });
});
