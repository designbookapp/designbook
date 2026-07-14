import { describe, expect, it } from "vitest";
import {
  buildPagePromptPrefill,
  canGoToComponent,
  canPromptSandbox,
  chipLabel,
  domLabel,
  nextToolState,
  unionBox,
  type PageHit,
  type ToolState,
} from "./pageHit";

describe("domLabel / chipLabel", () => {
  it("prefers id, then first class, then bare tag", () => {
    expect(domLabel({ tag: "div", id: "root", classes: ["a", "b"] })).toBe(
      "div#root",
    );
    expect(domLabel({ tag: "button", classes: ["Island", "x"] })).toBe(
      "button.Island",
    );
    expect(domLabel({ tag: "span" })).toBe("span");
  });

  it("chipLabel uses the registry label for a component hit", () => {
    expect(
      chipLabel({ kind: "component", entryLabel: "Editor · Island" }),
    ).toBe("Editor · Island");
  });

  it("chipLabel falls back to the DOM css-ish label for a dom hit", () => {
    expect(
      chipLabel({ kind: "dom", dom: { tag: "nav", classes: ["bar"] } }),
    ).toBe("nav.bar");
  });
});

describe("unionBox", () => {
  it("unions viewport rects and drops zero-area rects", () => {
    const box = unionBox([
      { x: 10, y: 20, width: 30, height: 40 },
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 50, y: 10, width: 10, height: 10 },
    ]);
    expect(box).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });

  it("returns undefined when nothing is measurable", () => {
    expect(unionBox([])).toBeUndefined();
    expect(unionBox([{ x: 5, y: 5, width: 0, height: 0 }])).toBeUndefined();
  });
});

describe("canGoToComponent", () => {
  it("only for a registered component hit", () => {
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    expect(
      canGoToComponent({
        kind: "component",
        rect,
        label: "X",
        entryId: "set.X",
      }),
    ).toBe(true);
    expect(
      canGoToComponent({ kind: "component", rect, label: "X" }),
    ).toBe(false);
    expect(
      canGoToComponent({
        kind: "dom",
        rect,
        label: "div",
        dom: { tag: "div" },
      }),
    ).toBe(false);
  });
});

describe("canPromptSandbox (sandbox prompt-box guard)", () => {
  const rect = { x: 0, y: 0, width: 1, height: 1 };
  const anchor = {} as Element;
  const componentHit: PageHit = {
    kind: "component",
    rect,
    label: "Card",
    ownerKind: "entry",
    entryId: "product.ProductCard",
    sourcePath: "src/Card.tsx",
    instanceId: "product.ProductCard::1",
  };
  const entryElementHit: PageHit = {
    kind: "dom",
    rect,
    label: "div.badges",
    dom: { tag: "div", classes: ["badges"] },
    ownerKind: "entry",
    entryId: "product.ProductCard",
    sourcePath: "src/Card.tsx",
    exportName: "ProductCard",
    instanceId: "product.ProductCard::1::dom:2",
    anchor,
  };
  /** The bug's exact shape: HomePage's hero section — no registry entry. */
  const sourceOwnerHit: PageHit = {
    kind: "dom",
    rect,
    label: "section.rounded-xl",
    dom: { tag: "section", classes: ["rounded-xl"] },
    ownerKind: "source",
    ownerNames: ["HomePage", "App"],
    sourcePath: "",
    exportName: "HomePage",
    instanceId: "src:HomePage::dom:1",
    anchor,
  };

  it("accepts registered component + registered-owner element hits (unchanged)", () => {
    expect(canPromptSandbox(componentHit)).toBe(true);
    expect(canPromptSandbox(entryElementHit)).toBe(true);
  });

  it("ACCEPTS a source-owner DOM hit — even without a client sourcePath", () => {
    expect(canPromptSandbox(sourceOwnerHit)).toBe(true);
    expect(
      canPromptSandbox({ ...sourceOwnerHit, sourcePath: "src/pages/HomePage.tsx" }),
    ).toBe(true);
  });

  it("rejects hits without the pieces a pin needs", () => {
    // Raw DOM with no owner at all (non-React or unnamed chain).
    expect(
      canPromptSandbox({ kind: "dom", rect, label: "div", dom: { tag: "div" } }),
    ).toBe(false);
    // No live anchor → no element pin.
    expect(canPromptSandbox({ ...sourceOwnerHit, anchor: undefined })).toBe(false);
    // No instance id → no pin identity.
    expect(
      canPromptSandbox({ ...sourceOwnerHit, instanceId: undefined }),
    ).toBe(false);
    // No export name on a source owner → the server has nothing to scan for.
    expect(
      canPromptSandbox({ ...sourceOwnerHit, exportName: undefined }),
    ).toBe(false);
    // Component hits still require the registered identity.
    expect(
      canPromptSandbox({ ...componentHit, entryId: undefined }),
    ).toBe(false);
  });
});

describe("buildPagePromptPrefill", () => {
  const rect = { x: 0, y: 0, width: 1, height: 1 };

  it("carries file + usage line for a drilled component hit", () => {
    const hit: PageHit = {
      kind: "component",
      rect,
      label: "Editor · Island",
      entryId: "editor.Island",
      entryLabel: "Editor · Island",
      sourcePath: "packages/excalidraw/components/Island.tsx",
      codeTarget: {
        file: "packages/excalidraw/App.tsx",
        ownerExportName: "App",
        name: "Island",
        kind: "component",
        className: "panel",
      },
    };
    const text = buildPagePromptPrefill(hit);
    expect(text).toContain("Editor · Island");
    expect(text).toContain("packages/excalidraw/App.tsx");
    expect(text).toContain('<Island className="panel">');
  });

  it("uses the source path for an outermost component hit", () => {
    const text = buildPagePromptPrefill({
      kind: "component",
      rect,
      label: "Editor · Island",
      entryId: "editor.Island",
      entryLabel: "Editor · Island",
      sourcePath: "packages/excalidraw/components/Island.tsx",
    });
    expect(text).toContain("(packages/excalidraw/components/Island.tsx)");
  });

  it("describes an unregistered DOM hit with a fiber hint", () => {
    const text = buildPagePromptPrefill({
      kind: "dom",
      rect,
      label: "button.foo",
      dom: { tag: "button", classes: ["foo"] },
      hint: "Toolbar",
    });
    expect(text).toContain("button.foo");
    expect(text).toContain("inside <Toolbar>");
    expect(text).toContain("not a registered component");
  });
});

describe("nextToolState", () => {
  const off: ToolState = { tool: null, chatOpen: false };

  it("toggles select and leaves the drawer untouched (coexist)", () => {
    expect(nextToolState(off, { type: "toggleSelect" })).toEqual({
      tool: "select",
      chatOpen: false,
    });
    // Arming select with the drawer OPEN keeps the drawer open.
    expect(
      nextToolState(
        { tool: null, chatOpen: true },
        { type: "toggleSelect" },
      ),
    ).toEqual({ tool: "select", chatOpen: true });
    // Disarming preserves the drawer too.
    expect(
      nextToolState({ tool: "select", chatOpen: true }, { type: "toggleSelect" }),
    ).toEqual({ tool: null, chatOpen: true });
  });

  it("toggles the drawer and KEEPS the armed tool (coexist)", () => {
    expect(
      nextToolState({ tool: "select", chatOpen: false }, { type: "toggleChat" }),
    ).toEqual({ tool: "select", chatOpen: true });
    expect(
      nextToolState({ tool: "select", chatOpen: true }, { type: "toggleChat" }),
    ).toEqual({ tool: "select", chatOpen: false });
  });

  it("promptPi opens the drawer and keeps the armed tool", () => {
    expect(
      nextToolState({ tool: "select", chatOpen: false }, { type: "promptPi" }),
    ).toEqual({ tool: "select", chatOpen: true });
  });

  it("escape disarms the tool only when no chip is open", () => {
    expect(
      nextToolState(
        { tool: "select", chatOpen: false },
        { type: "escape", chipOpen: false },
      ),
    ).toEqual({ tool: null, chatOpen: false });
    expect(
      nextToolState(
        { tool: "select", chatOpen: false },
        { type: "escape", chipOpen: true },
      ),
    ).toEqual({ tool: "select", chatOpen: false });
  });

  it("toggles the text tool, exclusive with select but NOT the drawer", () => {
    expect(nextToolState(off, { type: "toggleText" })).toEqual({
      tool: "text",
      chatOpen: false,
    });
    // Arming text from select swaps tools (one active affordance).
    expect(
      nextToolState({ tool: "select", chatOpen: false }, { type: "toggleText" }),
    ).toEqual({ tool: "text", chatOpen: false });
    // Arming text KEEPS the drawer open (coexist).
    expect(
      nextToolState({ tool: null, chatOpen: true }, { type: "toggleText" }),
    ).toEqual({ tool: "text", chatOpen: true });
    // Toggling text off returns to no tool, drawer preserved.
    expect(
      nextToolState({ tool: "text", chatOpen: true }, { type: "toggleText" }),
    ).toEqual({ tool: null, chatOpen: true });
    // Arming select from text swaps back, drawer preserved.
    expect(
      nextToolState({ tool: "text", chatOpen: true }, { type: "toggleSelect" }),
    ).toEqual({ tool: "select", chatOpen: true });
  });

  it("escape disarms the text tool too (when no chip is open)", () => {
    expect(
      nextToolState(
        { tool: "text", chatOpen: false },
        { type: "escape", chipOpen: false },
      ),
    ).toEqual({ tool: null, chatOpen: false });
    expect(
      nextToolState(
        { tool: "text", chatOpen: false },
        { type: "escape", chipOpen: true },
      ),
    ).toEqual({ tool: "text", chatOpen: false });
  });
});
