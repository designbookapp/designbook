/**
 * Drawer threads-list helpers (UX v3 U2 + changeset layers L3): row assembly
 * with CONVERSATION grouping (conversation rows with their pins/changesets
 * nested; ungrouped bucket for legacy pins), general-chat title derivation
 * (context-block strip), relative times.
 */

import { describe, expect, it } from "vitest";
import {
  pinsFromStatus,
  type SandboxChangesetState,
} from "@designbook-ui/models/sandbox/sandboxModel";
import {
  buildThreadRows,
  firstUserText,
  formatLastActivity,
  generalChatTitle,
  stripContextBlock,
} from "./threadRows";

function pinAt(
  id: string,
  at: number,
  prompt: string,
  conversationId?: string,
) {
  return pinsFromStatus({
    pins: [
      {
        id,
        createdAt: at,
        ...(conversationId ? { conversationId } : {}),
        target: { file: "src/X.tsx", exportName: "X", name: `${id}-anchor` },
        resolved: false,
        busy: false,
        thread: [{ role: "user", text: prompt, at }],
        variants: [],
      },
    ],
  })[id];
}

function directChangeset(
  conversationId: string,
  overrides: Partial<SandboxChangesetState> = {},
): SandboxChangesetState {
  return {
    id: `direct-${conversationId}`,
    threadPinId: "",
    conversationId,
    title: "Direct edits",
    direct: true,
    active: true,
    drifted: false,
    basedOnInactive: false,
    dataAdditionCount: 2,
    overrides: [
      {
        module: "src/locales/en.json",
        exportName: "",
        variantFiles: [],
        alternatives: ["data"],
        selection: "data",
      },
    ],
    ...overrides,
  };
}

describe("buildThreadRows", () => {
  it("'New conversation' action first, then the live chat, then ungrouped pins + history by activity desc; current history dropped", () => {
    const rows = buildThreadRows({
      pins: [pinAt("a", 100, "older pin"), pinAt("b", 300, "newer pin")],
      history: [
        {
          path: "/s/current.jsonl",
          id: "cur",
          title: "live chat",
          createdAt: 1,
          lastActivityAt: 500,
          messageCount: 4,
          current: true,
        },
        {
          path: "/s/old.jsonl",
          id: "old",
          title: "old chat",
          createdAt: 1,
          lastActivityAt: 200,
          messageCount: 8,
          current: false,
        },
      ],
      chatFirstMessage: "live chat first message",
      chatLastActivityAt: 500,
    });
    expect(rows[0]).toMatchObject({ kind: "new", key: "new" });
    expect(rows[1]).toMatchObject({
      kind: "chat",
      title: "live chat first message",
    });
    // Legacy (conversation-less) pins land in the labeled ungrouped bucket,
    // interleaved with prior sessions by last activity.
    expect(rows.slice(2).map((row) => row.key)).toEqual([
      "label:ungrouped",
      "pin:b",
      "history:/s/old.jsonl",
      "pin:a",
    ]);
    const pinRow = rows.find((row) => row.key === "pin:b")!;
    expect(pinRow).toMatchObject({
      kind: "pin",
      title: "newer pin",
      anchorLabel: "b-anchor",
      status: "idle",
    });
  });

  it("fresh session: only the 'New conversation' action row", () => {
    const rows = buildThreadRows({ pins: [], history: [] });
    expect(rows).toEqual([
      { kind: "new", key: "new", title: "New conversation" },
    ]);
  });

  it("L3 grouping: live conversation nests its pins + direct-edits changeset", () => {
    const rows = buildThreadRows({
      pins: [
        pinAt("mine", 300, "live pin", "c-live"),
        pinAt("legacy", 400, "legacy pin"),
      ],
      history: [],
      chatFirstMessage: "make the card pop",
      chatLastActivityAt: 500,
      liveConversationId: "c-live",
      changesets: [directChangeset("c-live")],
    });
    expect(rows.map((row) => row.key)).toEqual([
      "new",
      "chat",
      "pin:mine",
      "changeset:direct-c-live",
      "label:ungrouped",
      "pin:legacy",
    ]);
    expect(rows[1]).toMatchObject({ conversationId: "c-live" });
    expect(rows[2]).toMatchObject({ kind: "pin", indent: true });
    expect(rows[3]).toMatchObject({
      kind: "changeset",
      changesetId: "direct-c-live",
      title: "Direct edits",
      fileCount: 1,
      dataAdditionCount: 2,
      indent: true,
    });
  });

  it("L3 grouping: a history conversation nests its pins + changeset; wire compat rows without conversationId stay flat", () => {
    const rows = buildThreadRows({
      pins: [pinAt("old-pin", 150, "past work", "c-old")],
      history: [
        {
          path: "/s/old.jsonl",
          id: "old",
          title: "old conversation",
          createdAt: 1,
          lastActivityAt: 200,
          messageCount: 8,
          current: false,
          conversationId: "c-old",
        },
        {
          path: "/s/ancient.jsonl",
          id: "ancient",
          title: "pre-L3 chat",
          createdAt: 1,
          lastActivityAt: 100,
          messageCount: 2,
          current: false,
        },
      ],
      changesets: [directChangeset("c-old")],
    });
    expect(rows.map((row) => row.key)).toEqual([
      "new",
      "history:/s/old.jsonl",
      "pin:old-pin",
      "changeset:direct-c-old",
      "history:/s/ancient.jsonl",
    ]);
    expect(rows[2]).toMatchObject({ kind: "pin", indent: true });
    expect(rows[3]).toMatchObject({ kind: "changeset", indent: true });
  });

  it("L3: an orphaned direct-edits changeset (no surviving conversation row) stays reachable at top level", () => {
    const rows = buildThreadRows({
      pins: [],
      history: [],
      changesets: [directChangeset("c-gone")],
    });
    expect(rows.map((row) => row.key)).toEqual([
      "new",
      "changeset:direct-c-gone",
    ]);
    expect(rows[1]).toMatchObject({ kind: "changeset" });
    expect(rows[1]).not.toHaveProperty("indent");
  });

  it("L3: a pin whose conversation has no surviving row falls back to the ungrouped bucket", () => {
    const rows = buildThreadRows({
      pins: [pinAt("stray", 100, "stray pin", "c-vanished")],
      history: [],
      chatFirstMessage: "live",
      liveConversationId: "c-live",
    });
    expect(rows.map((row) => row.key)).toEqual([
      "new",
      "chat",
      "label:ungrouped",
      "pin:stray",
    ]);
  });
});

describe("titles + times", () => {
  it("stripContextBlock/generalChatTitle recover the request from a context send", () => {
    const stored = [
      "Selected canvas node context:",
      "- component: Card",
      "",
      "User request:",
      "round the corners more",
    ].join("\n");
    expect(stripContextBlock(stored)).toBe("round the corners more");
    expect(generalChatTitle(stored)).toBe("round the corners more");
    expect(generalChatTitle(undefined)).toBe("New conversation");
    expect(generalChatTitle("plain ask\nmore")).toBe("plain ask");
  });

  it("firstUserText reads string and block content", () => {
    expect(
      firstUserText([
        { role: "assistant", content: "hi" },
        { role: "user", content: "make it pop" },
      ]),
    ).toBe("make it pop");
    expect(
      firstUserText([
        { role: "user", content: [{ type: "text", text: "block text" }] },
      ]),
    ).toBe("block text");
    expect(firstUserText([])).toBeUndefined();
    expect(firstUserText(undefined)).toBeUndefined();
  });

  it("formatLastActivity buckets", () => {
    const now = 1_000_000_000;
    expect(formatLastActivity(now, now - 10_000)).toBe("now");
    expect(formatLastActivity(now, now - 5 * 60_000)).toBe("5m");
    expect(formatLastActivity(now, now - 3 * 60 * 60_000)).toBe("3h");
    expect(formatLastActivity(now, now - 2 * 24 * 60 * 60_000)).toBe("2d");
  });
});
