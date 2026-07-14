/**
 * Pure helpers for the chat panel's THREADS navigation (UX v3, U2; hosted by
 * the full view's ChatPanel): row assembly (pin threads + the general chat +
 * chat history), titles, and relative-time formatting. DOM-free — unit-tested
 * in the node env.
 */

import {
  pinLastActivity,
  pinStatus,
  pinThreadTitle,
  type SandboxChangesetState,
  type SandboxPinState,
} from "@designbook-ui/models/sandbox/sandboxModel";
import { parseSelectionMessage } from "./messageTransforms";

const copy = {
  generalChat: "New conversation",
  directEdits: "Direct edits",
  ungrouped: "Ungrouped",
  justNow: "now",
};

/** Compact relative time for thread rows: `now`, `37s`, `5m`, `2h`, `3d`. */
function formatLastActivity(now: number, at: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 45_000) return copy.justNow;
  if (delta < 60_000 * 60) return `${Math.round(delta / 60_000)}m`;
  if (delta < 60_000 * 60 * 24) return `${Math.round(delta / (60_000 * 60))}h`;
  return `${Math.round(delta / (60_000 * 60 * 24))}d`;
}

/** The exact frame the chat's send-time context assembly composes — history
 * titles must show the REQUEST, not the context block. */
const CONTEXT_BLOCK_HEADER = "Selected canvas node context:";
const CONTEXT_BLOCK_REQUEST = "\nUser request:\n";

/** Strip a leading canvas-context block from a stored user message. */
function stripContextBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(CONTEXT_BLOCK_HEADER)) return trimmed;
  const request = trimmed.indexOf(CONTEXT_BLOCK_REQUEST);
  return request === -1
    ? trimmed
    : trimmed.slice(request + CONTEXT_BLOCK_REQUEST.length).trim();
}

const TITLE_CAP = 48;

function truncateTitle(line: string): string {
  return line.length > TITLE_CAP ? `${line.slice(0, TITLE_CAP - 1)}…` : line;
}

/** Minimal wire-message shape (the chat `state` event's messages). */
type RawWireMessage = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

/** First user message's text from the live chat's wire messages. */
function firstUserText(messages: RawWireMessage[] | undefined): string | undefined {
  const first = messages?.find((message) => message.role === "user");
  if (!first) return undefined;
  const text =
    typeof first.content === "string"
      ? first.content
      : (first.content ?? [])
          .filter((block) => block.type === "text" && block.text)
          .map((block) => block.text)
          .join("\n");
  return text.trim() || undefined;
}

/** The general chat thread's title: derived from its first user message
 * (context block stripped); a fresh session stays "New conversation". */
function generalChatTitle(firstMessage: string | undefined): string {
  if (!firstMessage) return copy.generalChat;
  // Conversation-routed asks: a selection-scoped first message titles by
  // its bare REQUEST (the chip carries the scope), never the context frame.
  const selection = parseSelectionMessage(firstMessage);
  const line = (selection?.request ?? stripContextBlock(firstMessage))
    .split("\n")
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return line ? truncateTitle(line) : copy.generalChat;
}

/** One chat-history session row off the wire (GET /api/sandbox/threads). */
type ChatHistoryThread = {
  path: string;
  id: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  current: boolean;
  /** L3: the conversation this session was (grouping key). */
  conversationId?: string;
  /** G4: set when this conversation was FORKED off another (park-fork's
   * sliced chat) — the list nests/badges it under the parent. */
  parentConversationId?: string;
};

type ThreadRowStatus = "idle" | "working" | "generating" | "ready" | "failed";

type ThreadRow =
  | {
      /** The explicit "New conversation" ACTION row (L3): starting one
       * actually resets the per-branch Pi session. */
      kind: "new";
      key: "new";
      title: string;
    }
  | {
      /** The LIVE conversation's row (only once it has content). */
      kind: "chat";
      key: "chat";
      title: string;
      at?: number;
      conversationId?: string;
    }
  | {
      kind: "pin";
      key: string;
      pinId: string;
      title: string;
      /** The selection the thread is anchored to (e.g. `Product · Card`). */
      anchorLabel: string;
      status: ThreadRowStatus;
      at: number;
      /** Nested under its conversation row (L3 grouping). */
      indent?: boolean;
    }
  | {
      kind: "history";
      key: string;
      path: string;
      title: string;
      messageCount: number;
      at: number;
      conversationId?: string;
      /** G4: this conversation forked off `forkOf` (badge + nesting). */
      forkOf?: string;
      indent?: boolean;
    }
  | {
      /** A conversation's DIRECT-EDITS changeset (pin-less; L3). */
      kind: "changeset";
      key: string;
      changesetId: string;
      title: string;
      fileCount: number;
      dataAdditionCount: number;
      active: boolean;
      indent?: boolean;
    }
  | {
      /** Section label (the "Ungrouped" bucket for legacy pins). */
      kind: "label";
      key: string;
      title: string;
    };

/** The direct-edits changeset row of one conversation, if it exists. */
function directChangesetRow(
  changesets: SandboxChangesetState[],
  conversationId: string,
  indent: boolean,
): ThreadRow[] {
  return changesets
    .filter(
      (changeset) =>
        changeset.direct && changeset.conversationId === conversationId,
    )
    .map((changeset) => ({
      kind: "changeset" as const,
      key: `changeset:${changeset.id}`,
      changesetId: changeset.id,
      title: changeset.title ?? copy.directEdits,
      fileCount: changeset.overrides.length,
      dataAdditionCount: changeset.dataAdditionCount,
      active: changeset.active,
      ...(indent ? { indent: true } : {}),
    }));
}

/**
 * Assemble the all-threads list (L3 grouping — conversation rows with their
 * changesets/pins nested):
 *
 *   1. the "New conversation" ACTION row (a real session reset);
 *   2. the LIVE conversation (once it has content): its chat row, then its
 *      pins + direct-edits changeset nested;
 *   3. prior conversations (history rows) + UNGROUPED pins (legacy /
 *      conversation-less) interleaved by last activity — a history row with
 *      a conversationId nests that conversation's pins/changesets beneath
 *      it; pins whose conversation has no surviving row fall back to the
 *      ungrouped bucket (labeled when conversation rows exist above it).
 */
function buildThreadRows(params: {
  pins: SandboxPinState[];
  history: ChatHistoryThread[];
  chatFirstMessage?: string;
  chatLastActivityAt?: number;
  /** The live session's conversation id (serializeSession.conversationId). */
  liveConversationId?: string;
  /** The home's changesets (direct-edits rows nest under conversations). */
  changesets?: SandboxChangesetState[];
}): ThreadRow[] {
  const changesets = params.changesets ?? [];
  const live = params.liveConversationId;
  const pinRow = (
    pin: SandboxPinState,
    indent: boolean,
  ): Extract<ThreadRow, { kind: "pin" }> => ({
    kind: "pin",
    key: `pin:${pin.id}`,
    pinId: pin.id,
    title: pinThreadTitle(pin),
    anchorLabel: pin.target.name,
    status: pinStatus(pin),
    at: pinLastActivity(pin),
    ...(indent ? { indent: true } : {}),
  });
  const rows: ThreadRow[] = [
    { kind: "new", key: "new", title: copy.generalChat },
  ];
  const placedPins = new Set<string>();

  const toHistoryRow = (
    thread: ChatHistoryThread,
    indent: boolean,
  ): Extract<ThreadRow, { kind: "history" }> => ({
    kind: "history" as const,
    key: `history:${thread.path}`,
    path: thread.path,
    title: thread.title,
    messageCount: thread.messageCount,
    at: thread.lastActivityAt,
    ...(thread.conversationId
      ? { conversationId: thread.conversationId }
      : {}),
    ...(thread.parentConversationId
      ? { forkOf: thread.parentConversationId }
      : {}),
    ...(indent ? { indent: true } : {}),
  });
  // G4: forked conversations whose PARENT has a surviving row nest under
  // it; orphaned forks fall back to the flat list (still badged).
  const parentRowIds = new Set([
    ...(live ? [live] : []),
    ...params.history
      .filter((thread) => !thread.current && thread.conversationId)
      .map((thread) => thread.conversationId as string),
  ]);
  const nestedForks = new Map<string, ChatHistoryThread[]>();
  for (const thread of params.history) {
    if (thread.current || !thread.parentConversationId) continue;
    if (
      !parentRowIds.has(thread.parentConversationId) ||
      thread.parentConversationId === thread.conversationId
    ) {
      continue;
    }
    const list = nestedForks.get(thread.parentConversationId) ?? [];
    list.push(thread);
    nestedForks.set(thread.parentConversationId, list);
  }
  const nestedPaths = new Set(
    [...nestedForks.values()].flat().map((thread) => thread.path),
  );
  const forkRowsFor = (conversationId: string): ThreadRow[] =>
    (nestedForks.get(conversationId) ?? [])
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((thread) => toHistoryRow(thread, true));

  // 2. The live conversation block.
  const livePins = live
    ? params.pins.filter((pin) => pin.conversationId === live)
    : [];
  const liveChangesetRows = live ? directChangesetRow(changesets, live, true) : [];
  if (params.chatFirstMessage || livePins.length > 0 || liveChangesetRows.length > 0) {
    rows.push({
      kind: "chat",
      key: "chat",
      title: generalChatTitle(params.chatFirstMessage),
      ...(params.chatLastActivityAt ? { at: params.chatLastActivityAt } : {}),
      ...(live ? { conversationId: live } : {}),
    });
    for (const pin of [...livePins].sort(
      (a, b) => pinLastActivity(b) - pinLastActivity(a),
    )) {
      rows.push(pinRow(pin, true));
      placedPins.add(pin.id);
    }
    rows.push(...liveChangesetRows);
    if (live) rows.push(...forkRowsFor(live));
  }

  // 3. Prior conversations + ungrouped pins, interleaved by activity.
  const historyConversationIds = new Set(
    params.history
      .filter((thread) => !thread.current && thread.conversationId)
      .map((thread) => thread.conversationId as string),
  );
  const historyRows = params.history
    .filter((thread) => !thread.current && !nestedPaths.has(thread.path))
    .map((thread) => ({
      row: toHistoryRow(thread, false),
      at: thread.lastActivityAt,
    }));
  const ungroupedPins = params.pins.filter(
    (pin) =>
      !placedPins.has(pin.id) &&
      (!pin.conversationId ||
        (pin.conversationId !== live &&
          !historyConversationIds.has(pin.conversationId))),
  );
  const interleaved = [
    ...historyRows,
    ...ungroupedPins.map((pin) => {
      const row = pinRow(pin, false);
      return { row, at: row.kind === "pin" ? row.at : 0 };
    }),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  const hasConversationRows =
    rows.some((row) => row.kind === "chat") ||
    historyRows.some((entry) => entry.row.conversationId);
  let labeledUngrouped = false;
  for (const entry of interleaved) {
    if (entry.row.kind === "pin") {
      // The ungrouped bucket: label it once when conversation rows exist.
      if (hasConversationRows && !labeledUngrouped) {
        rows.push({ kind: "label", key: "label:ungrouped", title: copy.ungrouped });
        labeledUngrouped = true;
      }
      rows.push(entry.row);
      continue;
    }
    rows.push(entry.row);
    const conversationId = entry.row.conversationId;
    if (!conversationId) continue;
    for (const pin of params.pins
      .filter(
        (pin) =>
          !placedPins.has(pin.id) && pin.conversationId === conversationId,
      )
      .sort((a, b) => pinLastActivity(b) - pinLastActivity(a))) {
      rows.push(pinRow(pin, true));
      placedPins.add(pin.id);
    }
    if (conversationId !== live) {
      rows.push(...directChangesetRow(changesets, conversationId, true));
    }
    rows.push(...forkRowsFor(conversationId));
  }

  // Orphaned direct-edits layers (their conversation has no surviving row)
  // stay reachable — bake/discard must never be stranded.
  const shownChangesets = new Set(
    rows.flatMap((row) =>
      row.kind === "changeset" ? [row.changesetId] : [],
    ),
  );
  for (const changeset of changesets) {
    if (!changeset.direct || shownChangesets.has(changeset.id)) continue;
    rows.push({
      kind: "changeset",
      key: `changeset:${changeset.id}`,
      changesetId: changeset.id,
      title: changeset.title ?? copy.directEdits,
      fileCount: changeset.overrides.length,
      dataAdditionCount: changeset.dataAdditionCount,
      active: changeset.active,
    });
  }
  return rows;
}

export {
  buildThreadRows,
  firstUserText,
  formatLastActivity,
  generalChatTitle,
  stripContextBlock,
  truncateTitle,
};
export type {
  ChatHistoryThread,
  RawWireMessage,
  ThreadRow,
  ThreadRowStatus,
};
