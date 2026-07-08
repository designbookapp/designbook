import { describe, expect, it } from "vitest";
import { messagesToThreadItems } from "@designbook-ui/models/chat/messageTransforms";

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
});
