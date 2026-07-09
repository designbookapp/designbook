import { describe, expect, it } from "vitest";
import { htmlNodeToString, type HtmlNode } from "./figmaHtml.ts";

describe("htmlNodeToString", () => {
  it("emits a static leaf with inlined style and escaped text", () => {
    const node: HtmlNode = {
      tag: "span",
      style: { color: "#111", "font-weight": "600" },
      text: "Hello <b> & co",
    };
    expect(htmlNodeToString(node)).toBe(
      '<span style="color: #111; font-weight: 600">Hello &lt;b&gt; &amp; co</span>',
    );
  });

  it("emits a content slot with its sample value", () => {
    const node: HtmlNode = { tag: "span", slot: "price", text: "$49.99" };
    expect(htmlNodeToString(node)).toBe('<span data-slot="price">$49.99</span>');
  });

  it("emits an i18n slot carrying the current translation (dotted ns.key)", () => {
    const node: HtmlNode = {
      tag: "span",
      i18n: "app.cart.add.button",
      text: "Add to cart",
    };
    expect(htmlNodeToString(node)).toBe(
      '<span data-i18n="app.cart.add.button">Add to cart</span>',
    );
  });

  it("emits per-property token bindings, sorted", () => {
    const node: HtmlNode = {
      tokens: {
        color: "color/primary",
        background: "color/surface",
        "border-radius": "radius/md",
      },
      children: [],
    };
    expect(htmlNodeToString(node)).toBe(
      '<div data-token-background="color/surface" data-token-border-radius="radius/md" data-token-color="color/primary"></div>',
    );
  });

  it("emits a nested component reference with no children", () => {
    const node: HtmlNode = {
      component: "product.ProductThumb",
      // children are intentionally ignored for a reference node.
      children: [{ tag: "span", text: "should not appear" }],
    };
    expect(htmlNodeToString(node)).toBe(
      '<div data-component="product.ProductThumb"></div>',
    );
  });

  it("emits an instance-swap slot as a bounded component reference", () => {
    const node: HtmlNode = {
      slotSwap: "icon",
      component: "icon.Star",
    };
    expect(htmlNodeToString(node)).toBe(
      '<div data-component="icon.Star" data-slot-swap="icon"></div>',
    );
  });

  it("emits a boolean-if slot and marks it hidden when off", () => {
    const shown: HtmlNode = { slotIf: "showBadge", children: [] };
    const hidden: HtmlNode = { slotIf: "showBadge", hidden: true, children: [] };
    expect(htmlNodeToString(shown)).toBe('<div data-slot-if="showBadge"></div>');
    expect(htmlNodeToString(hidden)).toBe(
      '<div data-slot-if="showBadge" hidden></div>',
    );
  });

  it("emits a list container with a single item template", () => {
    const node: HtmlNode = {
      list: true,
      children: [
        {
          children: [{ tag: "span", slot: "title", text: "First item" }],
        },
      ],
    };
    expect(htmlNodeToString(node)).toBe(
      [
        "<div data-list>",
        "  <div>",
        '    <span data-slot="title">First item</span>',
        "  </div>",
        "</div>",
      ].join("\n"),
    );
  });

  it("emits an image as a void element with src", () => {
    const node: HtmlNode = { tag: "img", src: "https://x/y.png" };
    expect(htmlNodeToString(node)).toBe('<img src="https://x/y.png" />');
  });

  it("renders a realistic card: static frame + slots + token + nested component", () => {
    const node: HtmlNode = {
      style: { display: "flex", "flex-direction": "column", gap: "8px" },
      tokens: { background: "color/surface" },
      children: [
        { component: "product.ProductThumb" },
        { tag: "span", slot: "title", text: "Wireless Headphones" },
        { tag: "span", slot: "price", text: "$49.99" },
        {
          slotIf: "onSale",
          hidden: true,
          children: [{ tag: "span", i18n: "product.sale", text: "On sale" }],
        },
      ],
    };
    expect(htmlNodeToString(node)).toBe(
      [
        '<div data-token-background="color/surface" style="display: flex; flex-direction: column; gap: 8px">',
        '  <div data-component="product.ProductThumb"></div>',
        '  <span data-slot="title">Wireless Headphones</span>',
        '  <span data-slot="price">$49.99</span>',
        '  <div data-slot-if="onSale" hidden>',
        '    <span data-i18n="product.sale">On sale</span>',
        "  </div>",
        "</div>",
      ].join("\n"),
    );
  });

  it("escapes attribute values", () => {
    const node: HtmlNode = { slot: 'a"b<c', text: "x" };
    expect(htmlNodeToString(node)).toBe(
      '<div data-slot="a&quot;b&lt;c">x</div>',
    );
  });
});
