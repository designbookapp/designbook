import { describe, expect, it } from "vitest";
import {
  getToolCallDetail,
  messagesToThreadItems,
  shapeMessageForDisplay,
} from "@designbook-ui/models/chat/messageTransforms";

describe("messagesToThreadItems", () => {
  it("renders user and assistant messages", () => {
    const items = messagesToThreadItems([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "message", text: "hello" });
    expect(items[1]).toMatchObject({ kind: "message", text: "hi" });
  });

  it("replaces an empty errored assistant message with an error marker", () => {
    const items = messagesToThreadItems([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "You exceeded your current quota.",
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "marker",
      status: "error",
      text: "You exceeded your current quota.",
    });
  });

  it("keeps a partial assistant message and appends the error marker", () => {
    const items = messagesToThreadItems([
      {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
        stopReason: "error",
        errorMessage: "connection dropped",
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "message", text: "partial answer" });
    expect(items[1]).toMatchObject({ kind: "marker", status: "error" });
  });

  it("shows the empty-thread marker when there are no messages", () => {
    const items = messagesToThreadItems([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "marker", id: "empty-thread" });
  });

  it("coalesces a thinking/tool-only assistant turn into an activity row, not an empty bubble", () => {
    const items = messagesToThreadItems([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "planning" },
          { type: "toolCall", id: "c1", name: "read" },
        ],
      },
    ]);

    // user message + activity — the assistant turn produces NO bubble.
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "message", text: "go" });
    expect(items[1]).toMatchObject({
      kind: "activity",
      status: "done",
      entries: [
        { type: "thinking", text: "planning" },
        { type: "tool", id: "c1", name: "read", status: "running" },
      ],
    });
  });

  it("resolves a tool entry from its toolResult and places activity BEFORE the text bubble", () => {
    const items = messagesToThreadItems([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "look" },
          { type: "toolCall", id: "c1", name: "read" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "file body" }],
      },
      { role: "assistant", content: [{ type: "text", text: "the answer" }] },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "activity", status: "done" });
    expect(items[0]).toMatchObject({
      entries: [
        { type: "thinking", text: "look" },
        { type: "tool", id: "c1", name: "read", status: "done" },
      ],
    });
    expect(items[1]).toMatchObject({ kind: "message", text: "the answer" });
  });

  it("marks a failed thinking/tool turn's activity errored and still emits the error marker", () => {
    const items = messagesToThreadItems([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "trying" },
          { type: "toolCall", id: "c1", name: "bash" },
        ],
        stopReason: "error",
        errorMessage: "You exceeded your current quota.",
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "activity", status: "error" });
    expect(items[1]).toMatchObject({
      kind: "marker",
      status: "error",
      text: "You exceeded your current quota.",
    });
  });

  it("stamps elapsed ms since the first message on messages and entries", () => {
    const t0 = 1_783_650_000_000;
    const items = messagesToThreadItems([
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: t0 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "planning" },
          { type: "toolCall", id: "c1", name: "read" },
        ],
        timestamp: t0 + 1200,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: t0 + 4600,
      },
    ]);

    expect(items[0]).toMatchObject({ kind: "message", at: 0 });
    expect(items[1]).toMatchObject({
      kind: "activity",
      entries: [
        { type: "thinking", at: 1200 },
        { type: "tool", id: "c1", at: 1200 },
      ],
    });
    expect(items[2]).toMatchObject({ kind: "message", at: 4600 });
  });

  it("carries a tool call's primary argument into the entry detail", () => {
    const items = messagesToThreadItems([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c1",
            name: "read",
            arguments: {
              path: "/Users/michael/Projects/vibe/designbook/packages/designbook/src/plugins/figma/skills/figma-pull/SKILL.md",
            },
          },
        ],
      },
    ]);

    const activity = items[0];
    if (activity.kind !== "activity" || activity.entries[0]?.type !== "tool") {
      throw new Error("expected a tool activity entry");
    }
    // Long path keeps its TAIL — the basename is the informative end.
    expect(activity.entries[0].detail?.startsWith("…")).toBe(true);
    expect(activity.entries[0].detail?.endsWith("figma-pull/SKILL.md")).toBe(
      true,
    );
  });
});

describe("getToolCallDetail", () => {
  it("prefers the subject-like key over other string args", () => {
    expect(
      getToolCallDetail({ verbose: "true", path: "src/a.ts" }),
    ).toBe("src/a.ts");
    expect(getToolCallDetail({ command: "ls -la" })).toBe("ls -la");
  });

  it("falls back to the first string value", () => {
    expect(getToolCallDetail({ target: "some-value" })).toBe("some-value");
  });

  it("returns undefined when nothing is summarizable", () => {
    expect(getToolCallDetail(undefined)).toBeUndefined();
    expect(getToolCallDetail({})).toBeUndefined();
    expect(getToolCallDetail({ count: 3 })).toBeUndefined();
  });

  it("truncates paths from the head and other values from the tail", () => {
    const longPath = `/very/${"deep/".repeat(12)}file.md`;
    const pathDetail = getToolCallDetail({ path: longPath });
    expect(pathDetail).toHaveLength(48);
    expect(pathDetail?.startsWith("…")).toBe(true);
    expect(pathDetail?.endsWith("file.md")).toBe(true);

    const longQuery = "q".repeat(80);
    const queryDetail = getToolCallDetail({ query: longQuery });
    expect(queryDetail).toHaveLength(48);
    expect(queryDetail?.endsWith("…")).toBe(true);
  });

  it("collapses a multi-line command into one line", () => {
    expect(getToolCallDetail({ command: "ls\n  -la" })).toBe("ls -la");
  });
});

// ---------------------------------------------------------------------------
// Conversation-routed asks: selection anchors, turn metadata, custom rows.
// ---------------------------------------------------------------------------

describe("shapeMessageForDisplay (conversation-routed asks)", () => {
  it("selection-scoped user message → pin-chip anchor + bare request", () => {
    const raw = [
      "[Selection: Product Card] (pin productcard-ab12)",
      'The designer selected the live component "ProductCard" …',
      "Captured props:",
      '- tone: "dark"',
      "",
      "User request:",
      "make it pop",
    ].join("\n");
    const shaped = shapeMessageForDisplay("user", raw);
    expect(shaped.anchor).toEqual({
      pinId: "productcard-ab12",
      label: "Product Card",
    });
    expect(shaped.text).toBe("make it pop");
  });

  it("plain user message stays untouched (no anchor)", () => {
    const shaped = shapeMessageForDisplay("user", "hello there");
    expect(shaped.anchor).toBeUndefined();
    expect(shaped.text).toBe("hello there");
  });

  it("assistant replies lose trailing Summary/Title metadata lines", () => {
    const shaped = shapeMessageForDisplay(
      "assistant",
      "Made it pop.\n\nSummary: punched up the card\nTitle: Poppy card",
    );
    expect(shaped.text).toBe("Made it pop.");
  });

  it("a mid-text quoted Summary line survives (tail-only strip)", () => {
    const body = [
      "Summary: not metadata, just quoting",
      ...Array.from({ length: 10 }, (_, i) => `line ${i}`),
    ].join("\n");
    expect(shapeMessageForDisplay("assistant", body).text).toBe(body);
  });
});

describe("custom transcript messages (variants in the conversation)", () => {
  it("designbook-selection-ask → anchored user-style message", () => {
    const items = messagesToThreadItems([
      {
        role: "custom",
        customType: "designbook-selection-ask",
        display: true,
        content: "[Selection: Hero] (pin hero-x1)\ngive me 3 options",
        details: { pinId: "hero-x1", label: "Hero", variants: true },
        timestamp: 10,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "message",
      role: "user",
      text: "give me 3 options",
      anchor: { pinId: "hero-x1", label: "Hero" },
    });
  });

  it("designbook-variants-result → variants row with this run's outcomes", () => {
    const items = messagesToThreadItems([
      { role: "user", content: "hi", timestamp: 1 },
      {
        role: "custom",
        customType: "designbook-variants-result",
        display: true,
        content: "designbook generated 2 design variants…",
        details: {
          pinId: "hero-x1",
          label: "Hero",
          variants: [
            { id: "warm", intent: "warmer", status: "ready" },
            { id: "cool", intent: "cooler", status: "failed" },
          ],
        },
        timestamp: 20,
      },
    ]);
    const row = items.find((item) => item.kind === "variants");
    expect(row).toMatchObject({
      pinId: "hero-x1",
      label: "Hero",
      variants: [
        { id: "warm", intent: "warmer", status: "ready" },
        { id: "cool", intent: "cooler", status: "failed" },
      ],
    });
  });

  it("hidden customs (display false — the turn-metadata instruction) render nothing", () => {
    const items = messagesToThreadItems([
      {
        role: "custom",
        customType: "designbook-turn-metadata",
        display: false,
        content: "End your reply with Summary: …",
        timestamp: 5,
      },
    ]);
    expect(items.some((item) => item.id !== "empty-thread")).toBe(false);
  });
});
