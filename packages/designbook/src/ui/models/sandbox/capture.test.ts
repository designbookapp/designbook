/**
 * Sandbox capture tests (docs/specs/sandbox.md, D2): value capping, the
 * `$unserializable` marker contract the wrapper generator relies on, and the
 * snapshot assembly (consumed-context filter, children stubbing).
 */

import { describe, expect, it } from "vitest";
import {
  buildElementLocator,
  captureSandboxContext,
  captureValue,
  hashLocatorText,
} from "./capture";

describe("captureValue", () => {
  it("passes JSON-safe primitives through and truncates long strings", () => {
    expect(captureValue(42)).toBe(42);
    expect(captureValue(true)).toBe(true);
    expect(captureValue(null)).toBe(null);
    const long = captureValue("x".repeat(200)) as string;
    expect(long.length).toBe(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("marks functions, elements, DOM nodes, and exotic types unserializable", () => {
    expect(captureValue(function onAdd() {})).toEqual({
      $unserializable: "function onAdd",
    });
    expect(captureValue({ $$typeof: Symbol("react") })).toEqual({
      $unserializable: "ReactElement",
    });
    expect(captureValue({ nodeType: 1, nodeName: "DIV" })).toEqual({
      $unserializable: "<div> element",
    });
    expect(captureValue(new Map([[1, 2]]))).toEqual({
      $unserializable: "Map(1)",
    });
    expect(captureValue(Symbol("s"))).toEqual({ $unserializable: "symbol" });
    expect(captureValue(Number.NaN)).toEqual({
      $unserializable: "number NaN",
    });
  });

  it("caps depth and entry counts; cuts cycles", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    expect(captureValue(deep)).toEqual({
      a: { b: { c: { $unserializable: "object (depth-capped)" } } },
    });
    const wide = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, i]),
    );
    expect(Object.keys(captureValue(wide) as object)).toHaveLength(8);
    const arr = Array.from({ length: 20 }, (_, i) => i);
    expect(captureValue(arr)).toHaveLength(8);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(captureValue(cyclic)).toEqual({
      self: { $unserializable: "circular" },
    });
  });

  it("serializes dates and stays JSON-round-trippable", () => {
    const captured = captureValue({
      when: new Date("2026-07-10T00:00:00Z"),
      items: [{ id: 1, label: "a" }],
    });
    expect(JSON.parse(JSON.stringify(captured))).toEqual(captured);
    expect((captured as { when: string }).when).toBe(
      "2026-07-10T00:00:00.000Z",
    );
  });
});

describe("captureSandboxContext", () => {
  const target = {
    file: "src/Card.tsx",
    exportName: "ProductCard",
    name: "Product Card",
    entryId: "product.ProductCard",
    instancePath: "product.ProductCard#0",
  };

  it("captures props (children stubbed), consumed contexts, adapter state", () => {
    const { target: outTarget, contextSnapshot } = captureSandboxContext({
      target,
      props: {
        title: "Vase",
        onAdd: () => {},
        children: { $$typeof: Symbol("react") },
      },
      contextScope: [
        { contextName: "CartContext", value: { items: 2 }, consumed: true, shadowed: false, ownerName: "CartProvider" },
        { contextName: "RouterContext", value: {}, consumed: false, shadowed: false },
        { contextName: "CartContext", value: { items: 9 }, consumed: true, shadowed: true },
      ],
      adapterState: { "theme:mode": "dark", "i18n:locale": "en-US" },
    });
    expect(outTarget).toEqual(target);
    expect(contextSnapshot.props.title).toBe("Vase");
    expect(contextSnapshot.props.onAdd).toEqual({
      $unserializable: "function onAdd",
    });
    expect(contextSnapshot.props.children).toEqual({
      $unserializable: "children (ReactNode)",
    });
    // Only consumed + unshadowed contexts survive.
    expect(contextSnapshot.contexts).toEqual([
      { name: "CartContext", value: { items: 2 }, ownerName: "CartProvider" },
    ]);
    expect(contextSnapshot.adapters).toEqual({
      "theme:mode": "dark",
      "i18n:locale": "en-US",
    });
    // The whole snapshot must survive the wire.
    expect(JSON.parse(JSON.stringify(contextSnapshot))).toEqual(
      contextSnapshot,
    );
  });

  it("degrades to empty slices when collectors had nothing", () => {
    const { contextSnapshot } = captureSandboxContext({ target });
    expect(contextSnapshot).toEqual({
      props: {},
      contexts: [],
      adapters: {},
      capturedPath: "/",
    });
  });

  it("records + normalizes the captured route (query/hash dropped, leading slash, default /)", () => {
    expect(
      captureSandboxContext({ target, capturedPath: "/trips/42?tab=x#top" })
        .contextSnapshot.capturedPath,
    ).toBe("/trips/42");
    expect(
      captureSandboxContext({ target, capturedPath: "trips" }).contextSnapshot
        .capturedPath,
    ).toBe("/trips");
    expect(
      captureSandboxContext({ target, capturedPath: "" }).contextSnapshot
        .capturedPath,
    ).toBe("/");
    expect(
      captureSandboxContext({ target }).contextSnapshot.capturedPath,
    ).toBe("/");
  });

  it("captures the element subtree section for ELEMENT pins (v2)", () => {
    const { contextSnapshot } = captureSandboxContext({
      target,
      element: {
        tag: "DIV",
        text: "  $29\n   was $39  ",
        props: {
          className: "flex items-baseline",
          onClick: () => {},
          children: { $$typeof: Symbol("react") },
        },
      },
    });
    expect(contextSnapshot.element).toEqual({
      tag: "div",
      text: "$29 was $39",
      props: {
        className: "flex items-baseline",
        onClick: { $unserializable: "function onClick" },
      },
    });
    expect(JSON.parse(JSON.stringify(contextSnapshot))).toEqual(
      contextSnapshot,
    );
  });

  it("records provider attribution + capped provider props and i18n info", () => {
    const { contextSnapshot } = captureSandboxContext({
      target,
      contextScope: [
        {
          contextName: "Context",
          value: { product: { title: "Vase" }, currency: "USD" },
          consumed: true,
          shadowed: false,
          ownerName: "ProductProvider",
          providerName: "ProductProvider",
          providerFile: "src/composite/product/context.tsx",
          providerProps: {
            product: { title: "Vase" },
            currency: "USD",
            onSelect: () => {},
            children: { $$typeof: Symbol("react") },
          },
        },
      ],
      i18n: {
        localePathPattern: "locales/{locale}/{namespace}.json",
        defaultNamespace: "app",
        defaultLocale: "en-US",
      },
    });
    const [entry] = contextSnapshot.contexts;
    expect(entry.providerName).toBe("ProductProvider");
    expect(entry.providerFile).toBe("src/composite/product/context.tsx");
    // Provider props are captured with the same marker contract; children
    // never survive (render-time structure, not data).
    expect(entry.providerProps).toEqual({
      product: { title: "Vase" },
      currency: "USD",
      onSelect: { $unserializable: "function onSelect" },
    });
    expect(contextSnapshot.i18n).toEqual({
      localePathPattern: "locales/{locale}/{namespace}.json",
      defaultNamespace: "app",
      defaultLocale: "en-US",
    });
    expect(JSON.parse(JSON.stringify(contextSnapshot))).toEqual(
      contextSnapshot,
    );
  });
});

describe("buildElementLocator (element pins, v2)", () => {
  it("caps the outerHTML/text/path and normalizes whitespace", () => {
    const locator = buildElementLocator({
      tag: "DIV",
      outerHtml: `<div>${"x".repeat(4096)}</div>`,
      textContent: `  price:\n   ${"y".repeat(400)}  `,
      className: "flex gap-2",
      childIndexPath: Array.from({ length: 64 }, (_, i) => i),
    });
    expect(locator.tag).toBe("div");
    expect(locator.outerHtml.length).toBe(2048);
    expect(locator.text!.length).toBe(160);
    expect(locator.text!.startsWith("price: ")).toBe(true);
    expect(locator.childIndexPath).toHaveLength(32);
    expect(locator.className).toBe("flex gap-2");
    // JSON-safe on the wire.
    expect(JSON.parse(JSON.stringify(locator))).toEqual(locator);
  });

  it("hashes the NORMALIZED text — a revive-stable identity", () => {
    const a = buildElementLocator({
      tag: "div",
      outerHtml: "<div>$29</div>",
      textContent: "  $29   was $39 ",
    });
    const b = buildElementLocator({
      tag: "div",
      outerHtml: "<div>$29</div>",
      textContent: "$29 was $39",
    });
    expect(a.textHash).toBe(b.textHash);
    expect(a.textHash).toBe(hashLocatorText("$29 was $39"));
    expect(a.textHash).not.toBe(hashLocatorText("$30 was $39"));
    // No text → still a locator (hash of empty, no text field).
    const empty = buildElementLocator({ tag: "img", outerHtml: "<img/>" });
    expect(empty.text).toBeUndefined();
    expect(typeof empty.textHash).toBe("string");
  });
});
