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
});
