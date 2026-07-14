/**
 * The `chat` model — the thread transform pipeline (upserts, live messages, tool
 * markers, prompt context, model-value round-trip) + injected action routing —
 * exercised through the canonical fixtures. Pure/DOM-free (the SSE machine lives
 * in `DesignChat`, covered by the e2e), so this drives the folds the surface
 * shares.
 */

import { describe, expect, it } from "vitest";
import {
  appendActivityEntry,
  buildPromptWithCanvasContext,
  completeActivity,
  createChatModel,
  emptyThreadMarker,
  formatSelectionMarkerSummary,
  getModelValue,
  parseModelValue,
  toLiveMessage,
  toToolEntry,
  truncateThreadForViewing,
  upsertMarker,
  upsertMessage,
} from "./chatModel";
import type { DesignActivity, ThreadItem } from "./types";
import { createChatFixture } from "./fixtures";
import type { CanvasNodeSelection } from "@designbook-ui/types";

describe("createChatModel (fixture / data mode)", () => {
  it("exposes session state + the rendered thread", () => {
    const fx = createChatFixture();
    const model = createChatModel({ data: fx.data });
    expect(model.state?.sessionId).toBe("sess-1234abcd");
    // user message → coalesced activity run → assistant reply.
    expect(model.threadItems).toHaveLength(3);
    expect(model.threadItems[1]).toMatchObject({ kind: "activity" });
    expect(model.getModelValue(fx.model)).toBe("anthropic:opus-4");
  });

  it("defaults to an empty thread with the empty-state marker", () => {
    const model = createChatModel();
    expect(model.threadItems).toEqual([emptyThreadMarker]);
  });

  it("routes send/abort/newSession/selectModel through injected actions", () => {
    const fx = createChatFixture();
    const model = createChatModel({
      data: fx.data,
      send: fx.send,
      abort: fx.abort,
      newSession: fx.newSession,
      selectModel: fx.selectModel,
    });
    void model.send("hi");
    void model.abort();
    void model.newSession();
    void model.selectModel("anthropic:opus-4");
    expect(fx.sent).toEqual(["hi"]);
    expect(fx.aborts).toBe(1);
    expect(fx.newSessions).toBe(1);
    expect(fx.models).toEqual(["anthropic:opus-4"]);
  });
});

describe("thread upserts", () => {
  it("drops the empty-state marker and appends, then replaces by id", () => {
    const first = toLiveMessage(
      { role: "assistant", content: "one", timestamp: 9 },
      "x",
    )!;
    let items = upsertMessage([emptyThreadMarker], first);
    expect(items).toEqual([first]);

    const updated = { ...first, text: "one two" };
    items = upsertMessage(items, updated);
    expect(items).toEqual([updated]);
  });

  it("upserts markers by id", () => {
    const running = {
      kind: "marker" as const,
      id: "m1",
      icon: "info" as const,
      text: "one",
    };
    let items = upsertMarker([emptyThreadMarker], running);
    expect(items).toEqual([running]);

    const updated = { ...running, text: "two" };
    items = upsertMarker(items, updated);
    expect(items).toEqual([updated]);
  });
});

describe("activity folds (live path)", () => {
  it("creates a run on the first entry, dropping the empty-state marker", () => {
    const items = appendActivityEntry(
      [emptyThreadMarker],
      { type: "thinking", text: "hmm " },
      "a1",
    );
    expect(items).toEqual([
      {
        kind: "activity",
        id: "a1",
        entries: [{ type: "thinking", text: "hmm " }],
        status: "running",
      },
    ]);
  });

  it("EXTENDS the last thinking entry across streamed deltas", () => {
    let items = appendActivityEntry([], { type: "thinking", text: "one " }, "a1");
    items = appendActivityEntry(items, { type: "thinking", text: "two" }, "a1");
    const activity = items[0] as DesignActivity;
    expect(activity.entries).toEqual([{ type: "thinking", text: "one two" }]);
  });

  it("starts a fresh thinking entry after a tool call", () => {
    let items = appendActivityEntry([], { type: "thinking", text: "first" }, "a1");
    items = appendActivityEntry(
      items,
      toToolEntry({ toolName: "grep", toolCallId: "c1" }, "running"),
      "a1",
    );
    items = appendActivityEntry(items, { type: "thinking", text: "second" }, "a1");
    const activity = items[0] as DesignActivity;
    expect(activity.entries).toEqual([
      { type: "thinking", text: "first" },
      { type: "tool", id: "c1", name: "grep", status: "running" },
      { type: "thinking", text: "second" },
    ]);
  });

  it("UPSERTS a tool entry by id — start→end flips its status in place", () => {
    let items = appendActivityEntry(
      [],
      toToolEntry({ toolName: "grep", toolCallId: "c1" }, "running"),
      "a1",
    );
    items = appendActivityEntry(
      items,
      toToolEntry({ toolName: "grep", toolCallId: "c1", isError: false }, "done"),
      "a1",
    );
    const activity = items[0] as DesignActivity;
    expect(activity.entries).toEqual([
      { type: "tool", id: "c1", name: "grep", status: "done" },
    ]);
  });

  it("keeps the start event's detail when the arg-less end event upserts", () => {
    let items = appendActivityEntry(
      [],
      toToolEntry(
        {
          toolName: "read",
          toolCallId: "c1",
          args: { path: "skills/figma-pull/SKILL.md" },
        },
        "running",
      ),
      "a1",
    );
    items = appendActivityEntry(
      items,
      toToolEntry({ toolName: "read", toolCallId: "c1", isError: false }, "done"),
      "a1",
    );
    const activity = items[0] as DesignActivity;
    expect(activity.entries).toEqual([
      {
        type: "tool",
        id: "c1",
        name: "read",
        status: "done",
        detail: "skills/figma-pull/SKILL.md",
      },
    ]);
  });

  it("completes (or errors) the run by id", () => {
    const items = appendActivityEntry([], { type: "thinking", text: "x" }, "a1");
    expect((completeActivity(items, "a1", "done")[0] as DesignActivity).status).toBe(
      "done",
    );
    expect(
      (completeActivity(items, "a1", "error")[0] as DesignActivity).status,
    ).toBe("error");
  });
});

describe("model value round-trip", () => {
  it("encodes and parses provider:id", () => {
    const value = getModelValue({ id: "opus-4", provider: "anthropic" });
    expect(parseModelValue(value)).toEqual({
      provider: "anthropic",
      modelId: "opus-4",
    });
  });
});

describe("buildPromptWithCanvasContext", () => {
  it("prepends the selected node's context to the message", () => {
    const node: CanvasNodeSelection = {
      label: "ProductCard",
      description: "the card",
      path: "src/ProductCard.tsx",
      dom: { tag: "button", classes: ["cta"] },
    };
    const prompt = buildPromptWithCanvasContext("make it bigger", node);
    expect(prompt).toContain("Selected canvas node context:");
    expect(prompt).toContain("- Label: ProductCard");
    expect(prompt).toContain("<button class=\"cta\">");
    expect(prompt).toContain("User request:\nmake it bigger");
  });

  it("returns the message unchanged with no selection", () => {
    expect(buildPromptWithCanvasContext("hi", undefined)).toBe("hi");
  });

  it("states BOTH the usage site and the definition for a drilled selection", () => {
    const node: CanvasNodeSelection = {
      label: "Card",
      description: "drilled instance",
      path: "src/composite/Card.tsx",
      exportName: "Card",
      codeTarget: {
        file: "src/composite/ProductCard.tsx",
        ownerExportName: "ProductCard",
        name: "Card",
        kind: "component",
      },
    };
    const prompt = buildPromptWithCanvasContext("restyle it", node);
    expect(prompt).toContain(
      "- Instance: <Card> used inside ProductCard at src/composite/ProductCard.tsx",
    );
    expect(prompt).toContain("- Component defined at: src/composite/Card.tsx");
  });

  it("collapsed marker summary frames a drilled instance at its usage site", () => {
    // The one-line marker the user actually sees above the chat input: a drilled
    // selection must read as the INSTANCE inside its owner, never the bare
    // definition path (which looked like the component itself was selected).
    const node: CanvasNodeSelection = {
      label: "Card",
      description: "drilled instance",
      path: "examples/demo/src/composite/product/ProductCard.tsx",
      exportName: "Card",
      codeTarget: {
        file: "examples/demo/src/composite/product/variants/Card.tsx",
        ownerExportName: "ProductCard",
        name: "Card",
        kind: "component",
      },
    };
    expect(formatSelectionMarkerSummary(node)).toBe(
      "Instance <Card> in ProductCard — examples/demo/src/composite/product/variants/Card.tsx",
    );
    // The definition path is NOT the collapsed summary (it lives in the expand).
    expect(formatSelectionMarkerSummary(node)).not.toBe(node.path);
  });

  it("collapsed marker summary keeps the definition path for a plain selection", () => {
    const node: CanvasNodeSelection = {
      label: "ProductCard",
      description: "the card",
      path: "examples/demo/src/composite/product/ProductCard.tsx",
    };
    expect(formatSelectionMarkerSummary(node)).toBe(node.path);
  });

  it("prefers the selection-context registry block over the legacy lines", () => {
    const node: CanvasNodeSelection = {
      label: "Card",
      description: "the card",
      path: "src/Card.tsx",
    };
    const block = "[core]\nComponent defined at src/Card.tsx\n[props]\nsize: \"lg\"";
    const prompt = buildPromptWithCanvasContext("hi", node, block);
    expect(prompt).toBe(
      `Selected canvas node context:\n${block}\n\nUser request:\nhi`,
    );
    expect(prompt).not.toContain("- Label:");
  });
});

// ---------------------------------------------------------------------------
// Chat time-travel under a park (history explorer).
// ---------------------------------------------------------------------------

describe("truncateThreadForViewing", () => {
  const message = (id: string): ThreadItem => ({
    kind: "message",
    id,
    role: "user",
    text: id,
    attachments: [],
  });
  const turnRow = (id: string, turn: string, changesetId: string): ThreadItem => ({
    kind: "turn",
    id,
    turn,
    changesetId,
    ref: "refs/designbook/changesets/cs/trunk",
    from: "a",
    to: "b",
    at: 1,
    files: [],
  });
  const thread: ThreadItem[] = [
    message("m1"),
    turnRow("t1", "sess/1", "cs-a"),
    message("m2"),
    turnRow("t2", "sess/2", "cs-a"),
    message("m3"),
  ];

  it("collapses everything after the parked turn's row behind ONE marker", () => {
    const truncated = truncateThreadForViewing(thread, {
      turn: "sess/1",
      changesetId: "cs-a",
    });
    expect(truncated.map((item) => item.id)).toEqual([
      "m1",
      "t1",
      "viewing-truncated",
    ]);
    const marker = truncated[2];
    expect(marker.kind).toBe("marker");
    expect((marker as { text: string }).text).toContain("3 later items");
  });

  it("parked on the LAST turn = nothing to hide", () => {
    const tail: ThreadItem[] = [message("m1"), turnRow("t2", "sess/2", "cs-a")];
    expect(
      truncateThreadForViewing(tail, { turn: "sess/2", changesetId: "cs-a" }),
    ).toBe(tail);
  });

  it("no park / unknown turn (pre-G4 record) = untouched thread", () => {
    expect(truncateThreadForViewing(thread, undefined)).toBe(thread);
    expect(
      truncateThreadForViewing(thread, { turn: "sess/9", changesetId: "cs-a" }),
    ).toBe(thread);
    // A matching turn id on ANOTHER changeset never truncates this thread.
    expect(
      truncateThreadForViewing(thread, { turn: "sess/1", changesetId: "cs-b" }),
    ).toBe(thread);
  });
});
