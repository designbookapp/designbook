import { describe, expect, it } from "vitest";
import {
  buildIterateElementDescriptor,
  DESCRIPTOR_MAX_OUTER_HTML,
  DESCRIPTOR_MAX_TEXT,
} from "./iterateDescriptor";

describe("buildIterateElementDescriptor", () => {
  it("keeps tag/id/classes/label and collapses text whitespace", () => {
    const descriptor = buildIterateElementDescriptor({
      tag: "DIV",
      id: "price",
      classes: ["flex", "gap-2"],
      label: "div.flex",
      text: "  $12.99 \n  per month ",
      outerHtml: '<div class="flex gap-2">$12.99</div>',
      componentHint: "ProductPrice",
    });
    expect(descriptor).toEqual({
      tag: "div",
      id: "price",
      classes: ["flex", "gap-2"],
      label: "div.flex",
      text: "$12.99 per month",
      outerHtml: '<div class="flex gap-2">$12.99</div>',
      componentHint: "ProductPrice",
    });
  });

  it("omits empty optionals entirely", () => {
    const descriptor = buildIterateElementDescriptor({
      tag: "span",
      label: "span",
      text: "   ",
      classes: [],
    });
    expect(descriptor).toEqual({ tag: "span", label: "span" });
  });

  it("caps outerHTML at ~1KB and text at its own cap", () => {
    const descriptor = buildIterateElementDescriptor({
      tag: "div",
      label: "div",
      text: "x".repeat(5000),
      outerHtml: `<div>${"y".repeat(5000)}</div>`,
    });
    expect(descriptor.outerHtml!.length).toBeLessThanOrEqual(
      DESCRIPTOR_MAX_OUTER_HTML,
    );
    expect(descriptor.outerHtml!.endsWith("…")).toBe(true);
    expect(descriptor.text!.length).toBeLessThanOrEqual(DESCRIPTOR_MAX_TEXT);
  });

  it("caps the class list", () => {
    const descriptor = buildIterateElementDescriptor({
      tag: "div",
      label: "div",
      classes: Array.from({ length: 40 }, (_, index) => `c${index}`),
    });
    expect(descriptor.classes).toHaveLength(12);
  });
});
