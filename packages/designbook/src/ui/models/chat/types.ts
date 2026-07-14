type RawTextContent = {
  type: "text";
  text: string;
};

type RawImageContent = {
  type: "image";
  data?: string;
  mimeType?: string;
  source?: {
    type?: string;
    mediaType?: string;
    data?: string;
  };
};

type RawThinkingContent = {
  type: "thinking";
  thinking: string;
};

type RawToolCallContent = {
  type: "toolCall";
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type RawContent =
  | RawTextContent
  | RawImageContent
  | RawThinkingContent
  | RawToolCallContent;

type RawAgentMessage = {
  role: string;
  content?: string | RawContent[];
  timestamp?: number;
  toolName?: string;
  /** Present on `toolResult` messages: the `toolCall` block id they answer. */
  toolCallId?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  /** `custom` role messages (extension-injected): designbook's
   * conversation-routed variants anchors ride these. */
  customType?: string;
  display?: boolean;
  details?: unknown;
};

type DesignAttachment = {
  id: string;
  title: string;
  description: string;
  dataUrl?: string;
};

type DesignMessage = {
  kind: "message";
  id: string;
  role: "assistant" | "user";
  text: string;
  attachments: DesignAttachment[];
  status?: string;
  /** Elapsed ms since the session's first message (testing/timing aid). */
  at?: number;
  /** Selection-scoped message (conversation-routed asks): the anchor pin —
   * rendered as a PIN CHIP; the context block is folded behind it. */
  anchor?: { pinId: string; label: string };
};

type DesignMarker = {
  kind: "marker";
  id: string;
  icon: "info" | "tool" | "warning";
  text: string;
  status?: "running" | "done" | "error";
};

/**
 * One line of "activity" inside a collapsed run — either a snippet of the
 * agent's thinking, or a single tool invocation with its live status. A run of
 * these (see `DesignActivity`) replaces the empty "Thinking…" bubbles that a
 * thinking/tool-only assistant turn used to produce.
 */
type ActivityEntry =
  | {
      type: "thinking";
      text: string;
      /** Elapsed ms since the session's first message (block/first-delta time). */
      at?: number;
    }
  | {
      type: "tool";
      /** The `toolCall` block / execution id — folds start↔end and result. */
      id: string;
      name: string;
      status: "running" | "done" | "error";
      /**
       * A compact summary of the call's primary argument (a path, command,
       * pattern…), e.g. `…igma-pull/SKILL.md` — see `getToolCallDetail`.
       * Absent when the args carried nothing summarizable (or on a
       * `tool_execution_end`, whose upsert must PRESERVE the start's detail).
       */
      detail?: string;
      /** Elapsed ms since the session's first message (call-start time; the
       * end event's upsert preserves it, like `detail`). */
      at?: number;
    };

/**
 * A claude.ai-style collapsed "activity" row: one subdued, expandable line per
 * contiguous run of thinking + tool calls. `status` is the run's overall state
 * — "running" while streaming, "done" once the turn's activity is complete,
 * "error" if the turn failed.
 */
type DesignActivity = {
  kind: "activity";
  id: string;
  entries: ActivityEntry[];
  status: "running" | "done" | "error";
};

/** One conversation turn's landed COMMIT RANGE (G2 history rows): the
 * sidecar record surfaced as a thread row — expandable diff, restore-to-
 * before-this-turn, and per-tool-write restore. */
type DesignTurn = {
  kind: "turn";
  id: string;
  /** `<piSessionId>/<n>` — the rollback API's turn key. */
  turn: string;
  changesetId: string;
  /** The hidden ref the turn committed on. */
  ref: string;
  from: string;
  to: string;
  /** Epoch ms the range was recorded (turn end). */
  at: number;
  /** Non-designbook files the turn changed (the row's summary). */
  files: string[];
  /** Round-2: generated 4-8 word description of the turn (async — lands
   * via the `turn-label` SSE event / a later fetch). */
  label?: string;
  /** First line of the driving user prompt (label fallback). */
  prompt?: string;
};

/** One conversation-routed VARIANTS fan-out, anchored in the thread at the
 * asking message (conversation-routed asks): the client renders the pin's
 * live variant CARDS here (flip/iterate/bake — the existing machinery). */
type DesignVariantsRow = {
  kind: "variants";
  id: string;
  pinId: string;
  label?: string;
  /** The transcript note (fallback rendering when no card renderer). */
  text: string;
  /** This run's variant outcomes, when known (completion note). */
  variants?: Array<{ id: string; intent: string; status: string }>;
  error?: string;
};

type ThreadItem =
  | DesignMarker
  | DesignMessage
  | DesignActivity
  | DesignTurn
  | DesignVariantsRow;

type ModelOption = {
  contextWindow?: number;
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
};

type DesignState = {
  /**
   * Branch-session scoping key (per-branch-sessions spec). ABSENT = the
   * primary checkout's session — the wire-compat encoding. The chat drops
   * any pi-event whose `branch` doesn't match this.
   */
  branch?: string;
  /** Display branch name of the session's worktree (primary included). */
  branchName?: string;
  /** L3: the live session's conversation identity (drawer grouping + the
   * G2 turn-row fetch). */
  conversationId?: string;
  cwd: string;
  isStreaming: boolean;
  messages: RawAgentMessage[];
  model?: ModelOption | null;
  sessionFile?: string;
  sessionId: string;
  /** DESIGNBOOK_TIMINGS=1 on the server: show elapsed-ms chips in the thread. */
  showTimings?: boolean;
  thinkingLevel: string;
};

type PiEvent = {
  type?: string;
  /** Originating branch session; ABSENT = primary (wire compat). */
  branch?: string;
  message?: RawAgentMessage;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
  toolCallId?: string;
  toolName?: string;
  /** `tool_execution_start` only — the call's arguments (relayed verbatim). */
  args?: Record<string, unknown>;
  isError?: boolean;
  error?: string;
  result?: {
    content?: RawContent[];
  };
};

export type {
  ActivityEntry,
  DesignActivity,
  DesignAttachment,
  DesignMessage,
  DesignMarker,
  DesignState,
  DesignTurn,
  DesignVariantsRow,
  ModelOption,
  PiEvent,
  RawAgentMessage,
  RawContent,
  RawImageContent,
  RawThinkingContent,
  RawToolCallContent,
  ThreadItem,
};
