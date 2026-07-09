import { describe, expect, it } from "vitest";
import {
  appPageSelectDismissed,
  shouldArmAppPageSelect,
} from "./appPageTool";

describe("shouldArmAppPageSelect", () => {
  it("arms select when the user hasn't dismissed it this session", () => {
    expect(shouldArmAppPageSelect(false)).toBe(true);
  });

  it("stays off when the user dismissed select this session", () => {
    expect(shouldArmAppPageSelect(true)).toBe(false);
  });
});

describe("appPageSelectDismissed", () => {
  it("marks dismissed when the user switches to a non-select tool", () => {
    expect(appPageSelectDismissed("preview")).toBe(true);
    expect(appPageSelectDismissed("text")).toBe(true);
  });

  it("clears dismissed when the user switches back to select", () => {
    expect(appPageSelectDismissed("select")).toBe(false);
  });
});
