/**
 * The `chat` model — the thread transform pipeline (upserts, live messages, tool
 * markers, prompt context, model-value round-trip) + injected action routing —
 * exercised through the canonical fixtures. Pure/DOM-free (the SSE machine lives
 * in `DesignChat`, covered by the e2e), so this drives the folds the surface
 * shares.
 */

import { describe, expect, it } from "vitest";
import {
  buildPromptWithCanvasContext,
  createChatModel,
  emptyThreadMarker,
  formatSelectionMarkerSummary,
  getModelValue,
  getToolMarker,
  parseModelValue,
  toLiveMessage,
  upsertMarker,
  upsertMessage,
} from "./chatModel";
import { createChatFixture } from "./fixtures";
import type { CanvasNodeSelection } from "@designbook-ui/types";

describe("createChatModel (fixture / data mode)", () => {
  it("exposes session state + the rendered thread", () => {
    const fx = createChatFixture();
    const model = createChatModel({ data: fx.data });
    expect(model.state?.sessionId).toBe("sess-1234abcd");
    expect(model.threadItems).toHaveLength(2);
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
    const running = getToolMarker({ toolName: "grep", toolCallId: "c1" }, "running");
    let items = upsertMarker([emptyThreadMarker], running);
    expect(items).toEqual([running]);
    expect(running.text).toBe("Running grep");

    const done = getToolMarker({ toolName: "grep", toolCallId: "c1" }, "done");
    items = upsertMarker(items, done);
    expect(items).toEqual([done]);
    expect(done.text).toBe("Completed grep");
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
