/**
 * G2 turn rows (history UX): wire revival/dedupe, live upsert, and the
 * timestamp-anchored weave into the rendered thread — a record lands after
 * everything belonging to its own turn and before the next user prompt.
 */

import { describe, expect, it } from "vitest";
import {
  insertTurnRows,
  messageEpochFromId,
  reviveTurnRecord,
  turnRowsFromWire,
  upsertTurnRecord,
} from "./turnRows";
import type { DesignTurn, ThreadItem } from "./types";

const T0 = 1_700_000_000_000;

function record(turn: string, at: number, extra: Record<string, unknown> = {}) {
  return {
    turn,
    conversationId: "c-1",
    changesetId: "direct-c-1",
    ref: "refs/designbook/changesets/direct-c-1/trunk",
    from: "aaa",
    to: "bbb",
    at,
    ...extra,
  };
}

function message(role: "user" | "assistant", epoch: number): ThreadItem {
  return {
    kind: "message",
    id: `${role}-${epoch}`,
    role,
    text: `${role} @${epoch}`,
    attachments: [],
  };
}

describe("wire revival", () => {
  it("revives valid records, drops broken shapes, dedupes by turn key", () => {
    const rows = turnRowsFromWire([
      record("s/2", T0 + 200),
      record("s/1", T0 + 100, { files: ["src/Card.tsx"] }),
      record("s/1", T0 + 150), // later duplicate wins
      { turn: "", changesetId: "x", from: "a", to: "b" }, // invalid
      { changesetId: "x", from: "a", to: "b" }, // missing turn
    ]);
    expect(rows.map((row) => row.turn)).toEqual(["s/1", "s/2"]);
    expect(rows[0].at).toBe(T0 + 150);
    expect(reviveTurnRecord({ turn: "s/9" })).toBeUndefined();
  });

  it("upserts a live SSE record into the fetched list", () => {
    const rows = turnRowsFromWire([record("s/1", T0 + 100)]);
    const grown = upsertTurnRecord(rows, record("s/2", T0 + 300, { files: ["a.ts"] }));
    expect(grown.map((row) => row.turn)).toEqual(["s/1", "s/2"]);
    expect(grown[1].files).toEqual(["a.ts"]);
    // Re-announcing the same turn replaces, never duplicates.
    const replaced = upsertTurnRecord(grown, record("s/2", T0 + 300, { to: "ccc" }));
    expect(replaced).toHaveLength(2);
    expect(replaced[1].to).toBe("ccc");
  });
});

describe("messageEpochFromId", () => {
  it("parses live and restored id shapes; rejects epoch-free ids", () => {
    expect(messageEpochFromId(`user-${T0}`)).toBe(T0);
    expect(messageEpochFromId(`assistant-${T0}-3`)).toBe(T0);
    expect(messageEpochFromId("user-existing-2")).toBeUndefined();
    expect(messageEpochFromId("activity-live-123")).toBeUndefined();
  });
});

describe("insertTurnRows", () => {
  it("places each row after its own turn's messages and before the next user prompt", () => {
    const items: ThreadItem[] = [
      message("user", T0), // turn 1 prompt
      message("assistant", T0 + 50),
      message("user", T0 + 500), // turn 2 prompt (after turn 1's record)
      message("assistant", T0 + 550),
    ];
    const rows = turnRowsFromWire([
      record("s/1", T0 + 100),
      record("s/2", T0 + 600),
    ]);
    const woven = insertTurnRows(items, rows);
    expect(
      woven.map((item) =>
        item.kind === "turn" ? `turn:${item.turn}` : item.id,
      ),
    ).toEqual([
      `user-${T0}`,
      `assistant-${T0 + 50}`,
      "turn:s/1",
      `user-${T0 + 500}`,
      `assistant-${T0 + 550}`,
      "turn:s/2",
    ]);
  });

  it("no rows = the untouched item list; rows with no anchor append at the end", () => {
    const items: ThreadItem[] = [message("assistant", T0)];
    expect(insertTurnRows(items, [])).toBe(items);
    const rows: DesignTurn[] = turnRowsFromWire([record("s/1", T0 - 100)]);
    const woven = insertTurnRows(items, rows);
    expect(woven).toHaveLength(2);
    expect(woven[1].kind).toBe("turn");
  });
});
