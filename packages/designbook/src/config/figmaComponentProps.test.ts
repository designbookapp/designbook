import { describe, expect, it } from "vitest";
import {
  collectMainSlots,
  slotDescriptorToPropertyDef,
  slotReferenceAspect,
  type SlotDescriptor,
} from "./figmaComponentProps.ts";
import type { RenderNode } from "./figmaRender.ts";

describe("slotDescriptorToPropertyDef", () => {
  it("maps a text slot to a TEXT property driving characters", () => {
    const slot: SlotDescriptor = {
      kind: "text",
      name: "i18n.app.title",
      defaultValue: "Hello",
    };
    expect(slotDescriptorToPropertyDef(slot)).toEqual({
      name: "i18n.app.title",
      type: "TEXT",
      defaultValue: "Hello",
    });
    expect(slotReferenceAspect("text")).toBe("characters");
  });

  it("maps a boolean slot to a BOOLEAN property driving visibility", () => {
    const slot: SlotDescriptor = {
      kind: "boolean",
      name: "showBadge",
      defaultValue: false,
    };
    expect(slotDescriptorToPropertyDef(slot)).toEqual({
      name: "showBadge",
      type: "BOOLEAN",
      defaultValue: false,
    });
    expect(slotReferenceAspect("boolean")).toBe("visible");
  });

  it("maps an instance-swap slot to an INSTANCE_SWAP property", () => {
    const slot: SlotDescriptor = {
      kind: "instanceSwap",
      name: "icon",
      defaultValue: "12:34",
    };
    expect(slotDescriptorToPropertyDef(slot)).toEqual({
      name: "icon",
      type: "INSTANCE_SWAP",
      defaultValue: "12:34",
    });
    expect(slotReferenceAspect("instanceSwap")).toBe("mainComponent");
  });
});

describe("collectMainSlots", () => {
  const text = (
    i18n?: { namespace: string; key: string },
    characters = "x",
  ): RenderNode => ({
    dbId: "r",
    type: "text",
    name: characters,
    layout: { mode: "none", x: 0, y: 0, width: 1, height: 1 },
    text: {
      characters,
      i18n,
      font: { family: "Inter", weight: 400, italic: false, size: 12 },
      color: { r: 0, g: 0, b: 0, a: 1 },
      align: "left",
    },
  });

  it("collects i18n text slots as TEXT descriptors, deduped (dotted key)", () => {
    const root: RenderNode = {
      dbId: "r",
      type: "frame",
      name: "root",
      layout: { mode: "none", x: 0, y: 0, width: 10, height: 10 },
      children: [
        text({ namespace: "app", key: "cart.add.button" }, "Add to cart"),
        text(undefined, "literal — no slot"),
        text({ namespace: "app", key: "cart.add.button" }, "dup"),
      ],
    };
    expect(collectMainSlots(root)).toEqual([
      {
        kind: "text",
        name: "i18n.app.cart.add.button",
        defaultValue: "Add to cart",
      },
    ]);
  });

  it("stops at nested registered components (their main owns their slots)", () => {
    const root: RenderNode = {
      dbId: "r",
      type: "frame",
      name: "root",
      layout: { mode: "none", x: 0, y: 0, width: 10, height: 10 },
      children: [
        {
          dbId: "r.0",
          type: "childComponent",
          name: "Thumb",
          componentId: "product.Thumb",
          layout: { mode: "none", x: 0, y: 0, width: 5, height: 5 },
          children: [text({ namespace: "app", key: "nested" }, "nested")],
        },
      ],
    };
    expect(collectMainSlots(root)).toEqual([]);
  });
});
