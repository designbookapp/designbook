import type {
  ActivityEntry,
  DesignActivity,
  DesignAttachment,
  DesignMessage,
  DesignVariantsRow,
  RawAgentMessage,
  RawContent,
  RawImageContent,
  RawThinkingContent,
  RawToolCallContent,
  ThreadItem,
} from "./types";

// ---------------------------------------------------------------------------
// Conversation-routed asks: selection anchors + agent turn metadata.
// ---------------------------------------------------------------------------

/** The selection-scoped message prefix the server composes:
 * `[Selection: <label>] (pin <id>)` on the first line. */
const SELECTION_PREFIX = /^\[Selection: (.*?)\] \(pin ([A-Za-z0-9_-]+)\)/;

/**
 * Parse a selection-scoped user message: the anchor (pin chip) + the bare
 * REQUEST text — the capture context block between the prefix and the
 * trailing "User request:" section is display-noise (the chip carries the
 * scope; the model still sees everything). Undefined = not selection-scoped.
 */
function parseSelectionMessage(
  text: string,
): { pinId: string; label: string; request: string } | undefined {
  const match = SELECTION_PREFIX.exec(text);
  if (!match) return undefined;
  const label = match[1];
  const pinId = match[2];
  const requestMarker = text.lastIndexOf("\nUser request:\n");
  const request =
    requestMarker >= 0
      ? text.slice(requestMarker + "\nUser request:\n".length).trim()
      : text.slice(match[0].length).trim();
  return { pinId, label, request };
}

/**
 * Strip the agent-supplied `Summary:` / `Title:` metadata lines from an
 * assistant reply's TAIL (the last 8 non-empty lines — mirrors the server
 * parse in turnSummary.ts). They are turn metadata (labels/branch names),
 * never chat content.
 */
function stripTurnMetaLines(text: string): string {
  const lines = text.split("\n");
  const remove = new Set<number>();
  let seen = 0;
  for (let i = lines.length - 1; i >= 0 && seen < 8; i--) {
    if (!lines[i].trim()) continue;
    seen += 1;
    if (/^\s*(Summary|Title):\s+\S/.test(lines[i])) remove.add(i);
  }
  if (remove.size === 0) return text;
  return lines
    .filter((_, index) => !remove.has(index))
    .join("\n")
    .trimEnd();
}

function isThinkingContent(
  content: RawContent,
): content is RawThinkingContent {
  return content.type === "thinking";
}

function isToolCallContent(
  content: RawContent,
): content is RawToolCallContent {
  return content.type === "toolCall";
}

function isTextContent(
  content: RawContent,
): content is Extract<RawContent, { type: "text" }> {
  return content.type === "text";
}

function isImageContent(content: RawContent): content is RawImageContent {
  return content.type === "image";
}

function getImageDataUrl(content: RawImageContent) {
  const data = content.data ?? content.source?.data;
  const mimeType = content.mimeType ?? content.source?.mediaType ?? "image/png";

  if (!data) {
    return undefined;
  }

  return `data:${mimeType};base64,${data}`;
}

function getMessageText(message: RawAgentMessage) {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter(isTextContent)
    .map((content) => content.text)
    .join("\n");
}

function getMessageAttachments(
  message: RawAgentMessage,
  messageId: string,
): DesignAttachment[] {
  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content.filter(isImageContent).map((content, index) => ({
    id: `${messageId}-attachment-${index}`,
    title: `Image ${index + 1}`,
    description:
      content.mimeType ?? content.source?.mediaType ?? "Image attachment",
    dataUrl: getImageDataUrl(content),
  }));
}

/** Display shaping shared by the restore + live folds: assistant replies
 * lose their trailing turn-metadata lines; selection-scoped user messages
 * become anchored (pin chip) with only the bare request as text. */
function shapeMessageForDisplay(
  role: "assistant" | "user",
  rawText: string,
): { text: string; anchor?: DesignMessage["anchor"] } {
  if (role === "assistant") return { text: stripTurnMetaLines(rawText) };
  const selection = parseSelectionMessage(rawText);
  if (!selection) return { text: rawText };
  return {
    text: selection.request,
    anchor: { pinId: selection.pinId, label: selection.label },
  };
}

function toDesignMessage(
  message: RawAgentMessage,
  index: number,
  at?: number,
): DesignMessage | undefined {
  if (message.role !== "assistant" && message.role !== "user") {
    return undefined;
  }

  const id = `${message.role}-${message.timestamp ?? "existing"}-${index}`;
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
    at,
    ...(shaped.anchor ? { anchor: shaped.anchor } : {}),
  };
}

/**
 * A designbook CUSTOM transcript message (conversation-routed variants) →
 * its thread item: the ask renders as an anchored user-style message; the
 * result as the variant-cards row. Hidden custom messages (display false —
 * e.g. the turn-metadata instruction) and foreign custom types render
 * nothing.
 */
function customMessageToThreadItem(
  message: RawAgentMessage,
  index: number,
  at?: number,
): ThreadItem | undefined {
  if (message.role !== "custom" || message.display === false) {
    return undefined;
  }
  const text = getMessageText(message);
  const details = (message.details ?? {}) as {
    pinId?: unknown;
    label?: unknown;
    variants?: unknown;
    error?: unknown;
  };
  const pinId = typeof details.pinId === "string" ? details.pinId : undefined;
  if (message.customType === "designbook-selection-ask") {
    const selection = parseSelectionMessage(text);
    return {
      kind: "message",
      id: `custom-ask-${message.timestamp ?? "existing"}-${index}`,
      role: "user",
      text: selection?.request ?? text,
      attachments: [],
      at,
      ...(pinId || selection
        ? {
            anchor: {
              pinId: pinId ?? selection!.pinId,
              label:
                (typeof details.label === "string" && details.label) ||
                selection?.label ||
                "selection",
            },
          }
        : {}),
    };
  }
  if (message.customType === "designbook-variants-result" && pinId) {
    const variants = Array.isArray(details.variants)
      ? (details.variants as Array<{
          id?: unknown;
          intent?: unknown;
          status?: unknown;
        }>)
          .filter((entry) => typeof entry.id === "string")
          .map((entry) => ({
            id: entry.id as string,
            intent: typeof entry.intent === "string" ? entry.intent : "",
            status: typeof entry.status === "string" ? entry.status : "ready",
          }))
      : undefined;
    return {
      kind: "variants",
      id: `custom-variants-${message.timestamp ?? "existing"}-${index}`,
      pinId,
      ...(typeof details.label === "string" ? { label: details.label } : {}),
      text,
      ...(variants ? { variants } : {}),
      ...(typeof details.error === "string" ? { error: details.error } : {}),
    } satisfies DesignVariantsRow;
  }
  return undefined;
}

/** Argument keys most likely to be the call's "subject", in preference order —
 * a file path beats a generic option bag. */
const TOOL_DETAIL_KEYS = [
  "path",
  "file_path",
  "filePath",
  "filename",
  "file",
  "command",
  "cmd",
  "pattern",
  "query",
  "url",
  "name",
] as const;

const TOOL_DETAIL_MAX_LENGTH = 48;

/**
 * A tool call's arguments → the compact one-line detail shown next to its name
 * (`read …igma-pull/SKILL.md`). Picks the most subject-like argument (path >
 * command > pattern > … > first string), then truncates: path-ish values keep
 * their TAIL (the basename is the informative end), everything else keeps its
 * head. Returns undefined when nothing summarizable exists.
 */
function getToolCallDetail(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) {
    return undefined;
  }

  let value: string | undefined;
  for (const key of TOOL_DETAIL_KEYS) {
    const candidate = args[key];
    if (typeof candidate === "string" && candidate.trim()) {
      value = candidate;
      break;
    }
  }
  if (value === undefined) {
    value = Object.values(args).find(
      (candidate): candidate is string =>
        typeof candidate === "string" && Boolean(candidate.trim()),
    );
  }
  if (value === undefined) {
    return undefined;
  }

  // Collapse newlines (multi-line commands) into one displayable line.
  const line = value.trim().replace(/\s*\n\s*/g, " ");
  if (line.length <= TOOL_DETAIL_MAX_LENGTH) {
    return line;
  }
  return line.includes("/")
    ? `…${line.slice(line.length - (TOOL_DETAIL_MAX_LENGTH - 1))}`
    : `${line.slice(0, TOOL_DETAIL_MAX_LENGTH - 1)}…`;
}

/** The `thinking`/`toolCall` content blocks of an assistant message, in order,
 * as activity entries (tool status starts "running" — resolved by later
 * `toolResult` messages during the walk). */
function toActivityEntries(
  message: RawAgentMessage,
  index: number,
  at?: number,
): ActivityEntry[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  const entries: ActivityEntry[] = [];
  message.content.forEach((content, blockIndex) => {
    if (isThinkingContent(content)) {
      entries.push({ type: "thinking", text: content.thinking, at });
    } else if (isToolCallContent(content)) {
      entries.push({
        type: "tool",
        id: content.id ?? `${content.name ?? "tool"}-${index}-${blockIndex}`,
        name: content.name ?? "tool",
        status: "running",
        detail: getToolCallDetail(content.arguments),
        at,
      });
    }
  });
  return entries;
}

/**
 * Restore path: replay the full message history into thread items. The `state`
 * SSE event hands us the whole transcript, so we rebuild the thread from
 * scratch.
 *
 * Assistant turns are almost entirely thinking + tool calls — content blocks
 * with no display TEXT — and rendering those as messages produced empty bubbles
 * stuck on the "Thinking…" shimmer (getMessageText filters to text blocks).
 * Instead we COALESCE each contiguous run of thinking/tool activity into ONE
 * subdued `activity` row (claude.ai-style), flushed just BEFORE the assistant
 * message that finally carries text (or a user message, or a turn error). The
 * transcript also interleaves `toolResult` messages — matched back to their
 * `toolCall` by id — so each tool entry lands as done/error, not stuck running.
 */
function messagesToThreadItems(messages: RawAgentMessage[]) {
  const items: ThreadItem[] = [];

  // The open activity run being accumulated. It only becomes a thread item on
  // flush, so a run with no entries never renders.
  let activity: DesignActivity | undefined;

  /** Start (or reuse) the open run, keyed by the message index it began at. */
  function openActivity(index: number): DesignActivity {
    if (!activity) {
      activity = {
        kind: "activity",
        id: `activity-${index}`,
        entries: [],
        status: "running",
      };
    }
    return activity;
  }

  /** Emit the open run (if any entries) with a final status, then clear it. */
  function flushActivity(status: DesignActivity["status"]) {
    if (activity && activity.entries.length > 0) {
      items.push({ ...activity, status });
    }
    activity = undefined;
  }

  function pushErrorMarker(text: string, index: number) {
    items.push({
      kind: "marker",
      id: `turn-error-${index}`,
      icon: "warning",
      status: "error",
      text,
    });
  }

  // Elapsed-time origin: the session's first timestamped message. Every
  // message/entry gets `at = timestamp - t0` (a testing/timing aid).
  const t0 = messages.find((message) => message.timestamp)?.timestamp;

  messages.forEach((message, index) => {
    const at =
      t0 !== undefined && message.timestamp !== undefined
        ? message.timestamp - t0
        : undefined;

    // A tool's result: resolve the matching (still "running") tool entry in the
    // open run to done/error. Results carry no display line of their own.
    if (message.role === "toolResult") {
      if (activity && message.toolCallId) {
        activity.entries = activity.entries.map((entry) =>
          entry.type === "tool" && entry.id === message.toolCallId
            ? { ...entry, status: message.isError ? "error" : "done" }
            : entry,
        );
      }
      return;
    }

    if (message.role === "assistant") {
      const entries = toActivityEntries(message, index, at);
      if (entries.length > 0) {
        openActivity(index).entries.push(...entries);
      }

      const designMessage = toDesignMessage(message, index, at);
      const hasText = Boolean(designMessage && designMessage.text);
      const hasAttachments = Boolean(
        designMessage && designMessage.attachments.length > 0,
      );

      // A failed turn: mark the run errored, keep any partial text bubble, and
      // surface the error marker. An empty errored message never becomes a
      // bubble (it would show the stuck "Thinking…" shimmer).
      if (message.errorMessage) {
        flushActivity("error");
        if (designMessage && (hasText || hasAttachments)) {
          items.push(designMessage);
        }
        pushErrorMarker(message.errorMessage, index);
        return;
      }

      // Real assistant TEXT (or attachments) ends the run: flush it, THEN the
      // bubble, so activity reads above the answer. A thinking/tool-only
      // assistant message adds no bubble — its activity stays in the open run.
      if (designMessage && (hasText || hasAttachments)) {
        flushActivity("done");
        items.push(designMessage);
      }
      return;
    }

    // designbook custom messages (conversation-routed variants): the ask
    // anchor + the variant-cards row. Hidden/foreign customs render nothing.
    if (message.role === "custom") {
      const item = customMessageToThreadItem(message, index, at);
      if (item) {
        flushActivity("done");
        items.push(item);
      }
      return;
    }

    // A user message (or any other role) closes the preceding run.
    flushActivity("done");
    const designMessage = toDesignMessage(message, index, at);
    if (designMessage) {
      items.push(designMessage);
    }
    if (message.errorMessage) {
      pushErrorMarker(message.errorMessage, index);
    }
  });

  // Trailing run with no closing text (e.g. history captured mid-turn): a
  // restored transcript is settled, so mark it done.
  flushActivity("done");

  return items.length > 0
    ? items
    : [
        {
          kind: "marker",
          id: "empty-thread",
          icon: "info",
          text: "Start a conversation with the Pi coding agent.",
        } satisfies ThreadItem,
      ];
}

export {
  customMessageToThreadItem,
  getMessageAttachments,
  getMessageText,
  getToolCallDetail,
  messagesToThreadItems,
  parseSelectionMessage,
  shapeMessageForDisplay,
  stripTurnMetaLines,
  toActivityEntries,
};
