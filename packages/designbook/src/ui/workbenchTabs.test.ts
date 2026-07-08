import { describe, expect, it } from "vitest";
import {
  RIGHT_PANEL_TABS,
  isRightPanelTab,
  resolveInitialTabs,
} from "./workbenchTabs";

describe("isRightPanelTab", () => {
  it("accepts exactly the right-panel tab ids", () => {
    for (const tab of RIGHT_PANEL_TABS) expect(isRightPanelTab(tab)).toBe(true);
    expect(isRightPanelTab("files")).toBe(false);
    expect(isRightPanelTab("figma")).toBe(false);
    expect(isRightPanelTab("theme:tokens")).toBe(false);
    expect(isRightPanelTab(null)).toBe(false);
    expect(isRightPanelTab(42)).toBe(false);
  });
});

describe("resolveInitialTabs", () => {
  it("defaults to files / chat with nothing persisted", () => {
    expect(resolveInitialTabs(null, null)).toEqual({
      left: "files",
      right: "chat",
    });
  });

  it("keeps a persisted left tab and right tab", () => {
    expect(resolveInitialTabs("changes", "code")).toEqual({
      left: "changes",
      right: "code",
    });
  });

  it("passes adapter tab ids through on the left", () => {
    expect(resolveInitialTabs("theme:tokens", "props")).toEqual({
      left: "theme:tokens",
      right: "props",
    });
  });

  it("migrates a pre-split activeTab of chat/code to the right panel", () => {
    expect(resolveInitialTabs("chat", null)).toEqual({
      left: "files",
      right: "chat",
    });
    expect(resolveInitialTabs("code", null)).toEqual({
      left: "files",
      right: "code",
    });
  });

  it("prefers an explicit rightTab over a migrated activeTab", () => {
    expect(resolveInitialTabs("code", "props")).toEqual({
      left: "files",
      right: "props",
    });
  });

  it("drops an unknown rightTab back to chat", () => {
    expect(resolveInitialTabs("files", "bogus")).toEqual({
      left: "files",
      right: "chat",
    });
  });
});
