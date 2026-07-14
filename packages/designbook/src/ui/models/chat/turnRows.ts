/**
 * G2 turn rows (docs/specs/changesets-on-git.md §G2 — history UX): pure
 * folds that place a conversation's landed COMMIT RANGES (the sidecar's turn
 * records, GET /api/sandbox/turns) into the live thread as `turn` items —
 * each row carries the diff affordance, "restore to before this turn", and
 * the per-tool-write restore list (all rendered by TurnChangesRow).
 *
 * Placement is timestamp-anchored: a record lands BEFORE the first user
 * message that started after it (i.e. after everything belonging to its own
 * turn), trailing records at the end. Message epochs come from the thread
 * ids — both the live fold (`role-<timestamp>`) and the restore fold
 * (`role-<timestamp>-<index>`) embed the raw message timestamp. DOM-free,
 * unit-tested in the node env.
 */

import type { DesignTurn, ThreadItem } from "./types";

/** One sidecar turn record off the wire (GET /api/sandbox/turns + the
 * `conversation-turn` SSE event). */
type ConversationTurnWire = {
  turn?: string;
  conversationId?: string;
  changesetId?: string;
  ref?: string;
  from?: string;
  to?: string;
  at?: number;
  /** Present on the SSE event only (the fetch enumerates records). */
  files?: string[];
  /** Round-2: generated turn label + prompt-line fallback. */
  label?: string;
  prompt?: string;
};

/** Sanitize one wire record (bad shapes drop — never a broken row). */
function reviveTurnRecord(raw: ConversationTurnWire): DesignTurn | undefined {
  if (
    typeof raw.turn !== "string" ||
    !raw.turn ||
    typeof raw.changesetId !== "string" ||
    !raw.changesetId ||
    typeof raw.from !== "string" ||
    typeof raw.to !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "turn",
    id: `turn-${raw.changesetId}-${raw.turn}`,
    turn: raw.turn,
    changesetId: raw.changesetId,
    ref: typeof raw.ref === "string" ? raw.ref : "",
    from: raw.from,
    to: raw.to,
    at: typeof raw.at === "number" ? raw.at : 0,
    files: Array.isArray(raw.files)
      ? raw.files.filter((file): file is string => typeof file === "string")
      : [],
    ...(typeof raw.label === "string" && raw.label
      ? { label: raw.label }
      : {}),
    ...(typeof raw.prompt === "string" && raw.prompt
      ? { prompt: raw.prompt }
      : {}),
  };
}

/** All valid rows from a wire list, deduped by id (last record wins — the
 * SSE event may repeat what a later fetch also returns). */
function turnRowsFromWire(raw: ConversationTurnWire[]): DesignTurn[] {
  const byId = new Map<string, DesignTurn>();
  for (const record of raw) {
    const row = reviveTurnRecord(record);
    if (row) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

/** Upsert one live record (the `conversation-turn` SSE event) into the
 * fetched list. */
function upsertTurnRecord(
  rows: DesignTurn[],
  raw: ConversationTurnWire,
): DesignTurn[] {
  const row = reviveTurnRecord(raw);
  if (!row) return rows;
  return [...rows.filter((candidate) => candidate.id !== row.id), row].sort(
    (a, b) => a.at - b.at,
  );
}

/** The raw message timestamp a thread-item id embeds (`role-<ts>` live,
 * `role-<ts>-<index>` restored); undefined when the id carries none. */
function messageEpochFromId(id: string): number | undefined {
  const match = /^(?:user|assistant)-(\d{10,})/.exec(id);
  if (!match) return undefined;
  const epoch = Number(match[1]);
  return Number.isFinite(epoch) ? epoch : undefined;
}

/**
 * Weave turn rows into the rendered thread: each row lands before the first
 * USER message that started after its `at` (turn records are stamped at turn
 * end, so everything belonging to the turn precedes them), leftovers append.
 */
function insertTurnRows(
  items: ThreadItem[],
  turns: DesignTurn[],
): ThreadItem[] {
  if (turns.length === 0) return items;
  const queue = [...turns].sort((a, b) => a.at - b.at);
  const out: ThreadItem[] = [];
  for (const item of items) {
    if (item.kind === "message" && item.role === "user") {
      const epoch = messageEpochFromId(item.id);
      while (
        queue.length > 0 &&
        epoch !== undefined &&
        queue[0].at <= epoch
      ) {
        out.push(queue.shift()!);
      }
    }
    out.push(item);
  }
  out.push(...queue);
  return out;
}

/** Apply a `turn-label` SSE event to the fetched rows (round-2 labels are
 * generated ASYNC after the turn lands — the row updates in place). */
function applyTurnLabel(
  rows: DesignTurn[],
  raw: { turn?: string; changesetId?: string; label?: string },
): DesignTurn[] {
  if (
    typeof raw.turn !== "string" ||
    typeof raw.changesetId !== "string" ||
    typeof raw.label !== "string" ||
    !raw.label
  ) {
    return rows;
  }
  const id = `turn-${raw.changesetId}-${raw.turn}`;
  let changed = false;
  const out = rows.map((row) => {
    if (row.id !== id || row.label === raw.label) return row;
    changed = true;
    return { ...row, label: raw.label };
  });
  return changed ? out : rows;
}

export {
  applyTurnLabel,
  insertTurnRows,
  messageEpochFromId,
  reviveTurnRecord,
  turnRowsFromWire,
  upsertTurnRecord,
};
export type { ConversationTurnWire };
