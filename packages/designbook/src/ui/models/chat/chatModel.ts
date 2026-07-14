/**
 * The `chat` model — the Pi coding-agent session: its live state, its
 * message/thread transform pipeline, and the send/abort/new-session/model
 * actions.
 *
 * `DesignChat` drives a Server-Sent-Events stream from the design server and
 * folds each event into a flat `ThreadItem[]` (messages + tool/notice/error
 * markers). Every one of those folds is a PURE transform — build a display
 * message from a raw agent message, upsert it into the thread, build a tool
 * marker, prefill a prompt with the selected canvas node — and those transforms
 * used to live inline in the component. This model is the ONE home for them, so
 * the surface keeps only the SSE wiring + React state and a cell/test can drive
 * the same pipeline without a live server.
 *
 * ## Confirmed altitude (Michael 2026-07-07)
 * The stateful SSE machine (the `EventSource`, the `useState`/refs) STAYS in
 * `DesignChat`: this model exposes `send`/`abort`/`newSession`/`selectModel` as
 * INJECTED actions (the `fetch` calls), it does not absorb the event loop. Live
 * use feeds the current `state`/`threadItems` as `data` + the bound actions;
 * fixture/cell/test use feeds canonical `data` and the actions default to
 * no-ops.
 *
 * `createChatModel` is a pure factory (no React, no globals). The transform
 * functions are ALSO exported directly so `DesignChat` (which folds them inside
 * `setThreadItems` updaters, outside React render) imports them without the
 * context.
 */

import type { CanvasNodeSelection } from "@designbook-ui/types";
import {
  getMessageAttachments,
  getMessageText,
  getToolCallDetail,
  messagesToThreadItems,
  shapeMessageForDisplay,
} from "./messageTransforms";
import type {
  ActivityEntry,
  DesignActivity,
  DesignMarker,
  DesignMessage,
  DesignState,
  ModelOption,
  PiEvent,
  RawAgentMessage,
  ThreadItem,
} from "./types";

// ---------------------------------------------------------------------------
// Thread items — the empty-state marker + upsert folds.
// ---------------------------------------------------------------------------

/** Shown when the thread is empty (no messages yet). */
const emptyThreadMarker: ThreadItem = {
  kind: "marker",
  id: "empty-thread",
  icon: "info",
  text: "Start a conversation with the Pi coding agent.",
};

/** Drop the empty-state marker once any real item arrives. */
function removeEmptyThreadMarker(items: ThreadItem[]): ThreadItem[] {
  return items.filter((item) => item.id !== emptyThreadMarker.id);
}

/** Insert or replace a message by id (dropping the empty-state marker first). */
function upsertMessage(
  items: ThreadItem[],
  message: DesignMessage,
): ThreadItem[] {
  const nextItems = removeEmptyThreadMarker(items);
  const messageIndex = nextItems.findIndex((item) => item.id === message.id);
  if (messageIndex === -1) {
    return [...nextItems, message];
  }
  return nextItems.map((item, index) =>
    index === messageIndex ? message : item,
  );
}

/** Insert or replace a marker by id (dropping the empty-state marker first). */
function upsertMarker(items: ThreadItem[], marker: DesignMarker): ThreadItem[] {
  const nextItems = removeEmptyThreadMarker(items);
  const markerIndex = nextItems.findIndex((item) => item.id === marker.id);
  if (markerIndex === -1) {
    return [...nextItems, marker];
  }
  return nextItems.map((item, index) =>
    index === markerIndex ? marker : item,
  );
}

/**
 * CHAT TIME-TRAVEL under a park (history explorer): when the conversation's
 * changeset is parked on a past turn, the chat reads as it did at that
 * moment — items AFTER the parked turn's row collapse behind one marker
 * ("N later messages — exit viewing to return"). DISPLAY-LEVEL ONLY: the
 * transcript is untouched (prompting while parked = the implicit fork,
 * whose sliced transcript then exactly matches this truncated view). Runs
 * over the MERGED list (after insertTurnRows — the boundary is the parked
 * turn's own row). An unmatched turn (pre-G4 record) truncates nothing.
 */
function truncateThreadForViewing(
  items: ThreadItem[],
  parked: { turn: string; changesetId?: string } | undefined,
): ThreadItem[] {
  if (!parked?.turn) return items;
  const boundary = items.findIndex(
    (item) =>
      item.kind === "turn" &&
      item.turn === parked.turn &&
      (!parked.changesetId || item.changesetId === parked.changesetId),
  );
  if (boundary === -1 || boundary === items.length - 1) return items;
  const hidden = items.length - boundary - 1;
  return [
    ...items.slice(0, boundary + 1),
    {
      kind: "marker",
      id: "viewing-truncated",
      icon: "info",
      text: `${hidden} later ${hidden === 1 ? "item" : "items"} hidden — you are viewing this point in history. Exit viewing to return.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Live messages — a streaming/updated raw message → display message.
// ---------------------------------------------------------------------------

/** Stable id for a live message (role + timestamp, else a fallback). */
function getLiveMessageId(message: RawAgentMessage, fallbackId: string): string {
  return `${message.role}-${message.timestamp ?? fallbackId}`;
}

/** Raw agent message → display message, or undefined for a non-user/assistant role. */
function toLiveMessage(
  message: RawAgentMessage,
  fallbackId: string,
): DesignMessage | undefined {
  if (message.role !== "assistant" && message.role !== "user") {
    return undefined;
  }
  const id = getLiveMessageId(message, fallbackId);
  const shaped = shapeMessageForDisplay(
    message.role,
    getMessageText(message),
  );
  return {
    kind: "message",
    id,
    role: message.role,
    text: shaped.text,
    attachments: getMessageAttachments(message, id),
    ...(shaped.anchor ? { anchor: shaped.anchor } : {}),
  };
}

/** A tool-execution event → the activity entry it folds into a run. `status`
 * is "running" at `tool_execution_start` (which carries `args` → `detail`),
 * done/error at `tool_execution_end` (upserted by id, so the same row flips
 * state; the end event has no args — the upsert keeps the start's detail). */
function toToolEntry(
  event: PiEvent,
  status: Extract<ActivityEntry, { type: "tool" }>["status"],
  at?: number,
): Extract<ActivityEntry, { type: "tool" }> {
  const name = event.toolName ?? "tool";
  return {
    type: "tool",
    id: event.toolCallId ?? `${name}-${Date.now()}`,
    name,
    status,
    detail: getToolCallDetail(event.args),
    at,
  };
}

// ---------------------------------------------------------------------------
// Activity runs — the live fold for the collapsed thinking/tool row.
//
// The restore path (messageTransforms) rebuilds runs from the whole transcript;
// these two folds do the SAME job incrementally as SSE deltas arrive, so the
// live thread grows one activity row per turn instead of empty "Thinking…"
// bubbles + scattered tool markers. Pure, so they're unit-tested without a
// live server.
// ---------------------------------------------------------------------------

/**
 * Fold one entry into the open activity run `activityId`, creating the run if
 * it's the first entry of the turn. Thinking deltas EXTEND the run's last
 * thinking entry (a streamed thinking block arrives in chunks); a thinking
 * delta after a tool starts a fresh thinking entry. Tool entries UPSERT by id,
 * so `tool_execution_end` flips the same row running→done/error.
 */
function appendActivityEntry(
  items: ThreadItem[],
  entry: ActivityEntry,
  activityId: string,
): ThreadItem[] {
  const nextItems = removeEmptyThreadMarker(items);
  const index = nextItems.findIndex(
    (item): item is DesignActivity =>
      item.kind === "activity" && item.id === activityId,
  );

  if (index === -1) {
    const activity: DesignActivity = {
      kind: "activity",
      id: activityId,
      entries: [entry],
      status: "running",
    };
    return [...nextItems, activity];
  }

  const existing = nextItems[index] as DesignActivity;
  let entries: ActivityEntry[];

  if (entry.type === "thinking") {
    const last = existing.entries[existing.entries.length - 1];
    if (last && last.type === "thinking") {
      // Extending keeps the FIRST chunk's elapsed time — the block's start.
      entries = existing.entries.map((current, i) =>
        i === existing.entries.length - 1
          ? {
              type: "thinking",
              text: last.text + entry.text,
              at: last.at ?? entry.at,
            }
          : current,
      );
    } else {
      entries = [...existing.entries, entry];
    }
  } else {
    const toolIndex = existing.entries.findIndex(
      (current) => current.type === "tool" && current.id === entry.id,
    );
    // `tool_execution_end` carries no args (and lands later): keep the start
    // entry's detail AND elapsed time through the running→done/error flip.
    entries =
      toolIndex === -1
        ? [...existing.entries, entry]
        : existing.entries.map((current, i) =>
            i === toolIndex
              ? {
                  ...entry,
                  detail:
                    entry.detail ??
                    (current.type === "tool" ? current.detail : undefined),
                  at:
                    (current.type === "tool" ? current.at : undefined) ??
                    entry.at,
                }
              : current,
          );
  }

  const updated: DesignActivity = { ...existing, entries };
  return nextItems.map((item, i) => (i === index ? updated : item));
}

/** Mark the open activity run complete (or errored) — the turn ended. */
function completeActivity(
  items: ThreadItem[],
  activityId: string,
  status: DesignActivity["status"],
): ThreadItem[] {
  return items.map((item) =>
    item.kind === "activity" && item.id === activityId
      ? { ...item, status }
      : item,
  );
}

// ---------------------------------------------------------------------------
// Model select value <-> {provider, id}.
// ---------------------------------------------------------------------------

/** Model → the `provider:id` select value (both parts URI-encoded). */
function getModelValue(model: ModelOption): string {
  return `${encodeURIComponent(model.provider)}:${encodeURIComponent(model.id)}`;
}

/** `provider:id` select value → its parts (decoded). */
function parseModelValue(value: string): { provider: string; modelId: string } {
  const [provider, modelId] = value
    .split(":")
    .map((part) => decodeURIComponent(part));
  return { provider, modelId };
}

// ---------------------------------------------------------------------------
// Prompt context — fold the selected canvas node into the outgoing message.
// ---------------------------------------------------------------------------

function domTagSummary(dom: NonNullable<CanvasNodeSelection["dom"]>): string {
  const id = dom.id ? ` id="${dom.id}"` : "";
  const classes = dom.classes?.length ? ` class="${dom.classes.join(" ")}"` : "";
  return `<${dom.tag}${id}${classes}>`;
}

/**
 * The context section for the outgoing prompt. When the selection-context
 * registry resolved prompt fragments (PREVIEW — docs/specs/
 * selection-context.md), the assembled `contextBlock` IS the context; the
 * per-field lines remain as the fallback when nothing has resolved. The
 * fallback states BOTH the usage site and the definition for a drilled
 * selection (`codeTarget`) — the model must never see only the owner file.
 */
function buildCanvasContextBlock(
  selectedNode: CanvasNodeSelection | undefined,
  contextBlock?: string,
): string | undefined {
  if (!selectedNode) return undefined;
  if (contextBlock) return contextBlock;
  const lines = [
    `- Label: ${selectedNode.label}`,
    `- Description: ${selectedNode.description}`,
  ];
  if (selectedNode.dom) {
    lines.push(`- DOM element: ${domTagSummary(selectedNode.dom)}`);
  }
  if (selectedNode.codeTarget) {
    const target = selectedNode.codeTarget;
    lines.push(
      `- Instance: <${target.name}> used inside ${target.ownerExportName} at ${target.file}`,
      `- Component defined at: ${selectedNode.path}`,
    );
  } else {
    lines.push(`- Source path: ${selectedNode.path}`);
  }
  return lines.join("\n");
}

/**
 * Prepend the selected canvas node's context to the user's message (if any).
 * `contextBlock` is the selection-context registry's assembled block (see
 * buildSelectionContextBlock) captured at send time.
 */
function buildPromptWithCanvasContext(
  message: string,
  selectedNode: CanvasNodeSelection | undefined,
  contextBlock?: string,
): string {
  const block = buildCanvasContextBlock(selectedNode, contextBlock);
  if (!block) {
    return message;
  }
  return [
    "Selected canvas node context:",
    block,
    "",
    "User request:",
    message,
  ].join("\n");
}

/**
 * The collapsed one-line summary above the chat input's "Selected node context"
 * marker. For a DRILLED selection it frames the INSTANCE at its usage site
 * (`<Name> in Owner — owner file`) so the visible marker matches what the model
 * is told — never the bare definition path, which read as if the component
 * itself were selected. The definition path still shows in the expanded view
 * (buildCanvasContextBlock). Plain selections keep the definition path.
 */
function formatSelectionMarkerSummary(
  selectedNode: CanvasNodeSelection,
): string {
  const target = selectedNode.codeTarget;
  if (target) {
    return `Instance <${target.name}> in ${target.ownerExportName} — ${target.file}`;
  }
  return selectedNode.path;
}

// ---------------------------------------------------------------------------
// The model.
// ---------------------------------------------------------------------------

/** The canonical session state fed via the provider's `data` prop. */
type ChatData = {
  /** The live agent session (cwd, sessionId, streaming, model, …). */
  state?: DesignState;
  /** The current rendered thread (messages + markers). */
  threadItems: ThreadItem[];
};

/** The chat session actions, injected from `DesignChat`'s fetch calls. */
type ChatActions = {
  /** Send a message (already-composed prompt text). */
  send: (message: string) => void | Promise<void>;
  /** Abort the current turn. */
  abort: () => void | Promise<void>;
  /** Start a fresh conversation. */
  newSession: () => void | Promise<void>;
  /** Switch the active model (a `provider:id` select value). */
  selectModel: (value: string) => void | Promise<void>;
};

/** The chat model surface exposed on context and returned by the factory. */
type ChatModel = ChatData &
  ChatActions & {
    // Bundled pure transforms (the thread pipeline).
    toThreadItems: typeof messagesToThreadItems;
    emptyThreadMarker: ThreadItem;
    upsertMessage: typeof upsertMessage;
    upsertMarker: typeof upsertMarker;
    toLiveMessage: typeof toLiveMessage;
    toToolEntry: typeof toToolEntry;
    appendActivityEntry: typeof appendActivityEntry;
    completeActivity: typeof completeActivity;
    getModelValue: typeof getModelValue;
    parseModelValue: typeof parseModelValue;
    buildPrompt: typeof buildPromptWithCanvasContext;
  };

type CreateChatModelOptions = Partial<ChatActions> & {
  /** Canonical session state; omitted defaults to an empty thread. */
  data?: ChatData;
};

const noop = () => {};

/**
 * Build a chat model. Pure — no React, no globals. See the module doc for the
 * live (SSE-fed) vs. fixture split.
 */
function createChatModel(options: CreateChatModelOptions = {}): ChatModel {
  const data = options.data ?? { state: undefined, threadItems: [emptyThreadMarker] };
  return {
    state: data.state,
    threadItems: data.threadItems,
    send: options.send ?? noop,
    abort: options.abort ?? noop,
    newSession: options.newSession ?? noop,
    selectModel: options.selectModel ?? noop,
    toThreadItems: messagesToThreadItems,
    emptyThreadMarker,
    upsertMessage,
    upsertMarker,
    toLiveMessage,
    toToolEntry,
    appendActivityEntry,
    completeActivity,
    getModelValue,
    parseModelValue,
    buildPrompt: buildPromptWithCanvasContext,
  };
}

export {
  appendActivityEntry,
  buildCanvasContextBlock,
  buildPromptWithCanvasContext,
  completeActivity,
  createChatModel,
  emptyThreadMarker,
  formatSelectionMarkerSummary,
  getLiveMessageId,
  getModelValue,
  getToolCallDetail,
  messagesToThreadItems,
  parseModelValue,
  removeEmptyThreadMarker,
  toLiveMessage,
  toToolEntry,
  truncateThreadForViewing,
  upsertMarker,
  upsertMessage,
};
export type {
  ChatActions,
  ChatData,
  ChatModel,
  CreateChatModelOptions,
};
