import { describe, expect, it } from "vitest";
import {
  i18nBinding,
  i18nValueFromSlotName,
  isI18nSlotName,
  parseI18nValue,
} from "./figmaSlots.ts";

describe("i18nBinding (dot notation)", () => {
  it("builds layer/property/value with an explicit namespace", () => {
    expect(i18nBinding("cart", "add")).toEqual({
      layerName: "#i18n.cart.add",
      propertyName: "i18n.cart.add",
      value: "cart.add",
    });
  });

  it("preserves dots in a multi-segment key", () => {
    expect(i18nBinding("app", "cart.add.button")).toEqual({
      layerName: "#i18n.app.cart.add.button",
      propertyName: "i18n.app.cart.add.button",
      value: "app.cart.add.button",
    });
  });

  it("defaults the namespace when absent", () => {
    expect(i18nBinding(undefined, "greeting")).toEqual({
      layerName: "#i18n.app.greeting",
      propertyName: "i18n.app.greeting",
      value: "app.greeting",
    });
    expect(i18nBinding("", "x", "custom").value).toBe("custom.x");
  });
});

describe("parseI18nValue (first segment is namespace)", () => {
  it("splits a simple value", () => {
    expect(parseI18nValue("cart.add")).toEqual({
      namespace: "cart",
      key: "add",
    });
  });

  it("keeps dots in the key remainder", () => {
    // The key itself contains dots; only the FIRST segment is the namespace.
    expect(parseI18nValue("app.cart.add.button")).toEqual({
      namespace: "app",
      key: "cart.add.button",
    });
  });

  it("falls back to the default namespace when undotted", () => {
    expect(parseI18nValue("greeting")).toEqual({
      namespace: "app",
      key: "greeting",
    });
  });
});

describe("i18n slot-name helpers", () => {
  it("recognizes and unwraps i18n slot names", () => {
    expect(isI18nSlotName("i18n.app.cart.add.button")).toBe(true);
    expect(isI18nSlotName("price")).toBe(false);
    expect(i18nValueFromSlotName("i18n.app.cart.add.button")).toBe(
      "app.cart.add.button",
    );
  });
});

