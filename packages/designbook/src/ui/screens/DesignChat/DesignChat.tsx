import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { apiUrl } from "@designbook-ui/designbook";
import {
  subscribeApiEvents,
  subscribeConnectionStatus,
} from "@designbook-ui/models/events/eventBus";
import {
  BotIcon,
  CheckIcon,
  MapPinIcon,
  ChevronRightIcon,
  FileImageIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  SparklesIcon,
  SquareIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@designbook-ui/components/ui/attachment";
import { Avatar, AvatarFallback } from "@designbook-ui/components/ui/avatar";
import { Badge } from "@designbook-ui/components/ui/badge";
import { Button } from "@designbook-ui/components/ui/button";
import { Bubble, BubbleContent } from "@designbook-ui/components/ui/bubble";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@designbook-ui/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@designbook-ui/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@designbook-ui/components/ui/input-group";
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@designbook-ui/components/ui/marker";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@designbook-ui/components/ui/select";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@designbook-ui/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@designbook-ui/components/ui/message-scroller";
import { Spinner } from "@designbook-ui/components/ui/spinner";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@designbook-ui/components/ui/toggle-group";
import { cn } from "@designbook-ui/lib/utils";
import {
  appendActivityEntry,
  buildCanvasContextBlock,
  buildPromptWithCanvasContext,
  completeActivity,
  emptyThreadMarker,
  formatSelectionMarkerSummary,
  getModelValue,
  messagesToThreadItems,
  parseModelValue,
  toLiveMessage,
  toToolEntry,
  truncateThreadForViewing,
  upsertMarker,
  upsertMessage,
} from "@designbook-ui/models/chat/chatModel";
import {
  buildSelectionContextBlock,
  getSelectionContextSnapshot,
  subscribeSelectionContext,
} from "@designbook-ui/models/selectionContext/store";
import {
  insertTurnRows,
  applyTurnLabel,
  turnRowsFromWire,
  upsertTurnRecord,
  type ConversationTurnWire,
} from "@designbook-ui/models/chat/turnRows";
import { TurnChangesRow } from "./TurnChangesRow";
import type { CanvasNodeSelection } from "@designbook-ui/types";
import type {
  ActivityEntry,
  DesignActivity,
  DesignMarker,
  DesignMessage,
  DesignState,
  DesignTurn,
  DesignVariantsRow,
  ModelOption,
  PiEvent,
  ThreadItem,
} from "@designbook-ui/models/chat/types";

/** DOM id of the prompt textarea — exported so the workbench can focus it
 * after drafting a prompt into the chat tab (Figma pull handoff). */
const CHAT_PROMPT_INPUT_ID = "design-agent-prompt";

const copy = {
  abortCurrentResponse: "Abort current response",
  activityDone: "Done",
  activityRan: "Ran",
  activityRunning: "Running",
  activityThinking: "Thinking",
  activityWorked: "Worked on it",
  agentCwdLabel: "Agent cwd:",
  editAndRestart: "Edit prompt and restart conversation",
  editCancel: "Cancel",
  editRestart: "Restart",
  appDescription: "Describe the change. It lands as code in your repo.",
  appTitle: "designbook agent",
  assistantAvatarFallback: "π",
  assistantSender: "Pi",
  emptyThread: "Start a conversation with the Pi coding agent.",
  followUpMode: "Follow-up",
  messageDeliveryModeLabel: "Message delivery mode",
  messageFieldLabel: "Message",
  modelFieldLabel: "Model",
  modelPlaceholder: "Select model",
  newConversation: "New conversation",
  newConversationError: "Unable to start a new conversation.",
  noModelTitle: "Connect an AI model to use chat",
  noModelBody:
    "No model provider credential was found — the rest of the workbench works without one, but chat needs it. Either:",
  noModelLoginHint:
    "— OAuth or an API key, saved for next time, or",
  noModelEnvHint: "restart designbook with a provider key set, e.g.",
  noModelRetry: "Retry connection",
  selectedNodeContextLabel: "Selected node context",
  selectedNodeContextPending: "deriving…",
  selectedNodeHelp: "This context will be included with your next message.",
  selectedNodeHideContext: "Hide context",
  selectedNodeShowContext: "Show full context",
  promptPlaceholder:
    "Ask Pi to inspect files, draft UI changes, or explain this workspace.",
  sendMessage: "Send message",
  sessionLabel: "Session",
  starting: "starting…",
  switchModelError: "Unable to switch model.",
  steerMode: "Steer",
  thinking: "Thinking…",
  userAvatarFallback: "ME",
  userSender: "You",
  working: "Working",
};

/** Elapsed ms → compact label: `842ms`, `12.4s`, `1m 12s`. */
function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** The subdued `+12.4s` timing chip on messages and activity entries. Hidden
 * unless the server ran with DESIGNBOOK_TIMINGS=1 (state.showTimings). */
function ElapsedChip({ at, show }: { at?: number; show?: boolean }) {
  if (!show || at === undefined) {
    return null;
  }
  return (
    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
      +{formatElapsed(at)}
    </span>
  );
}

function getMarkerIcon(icon: DesignMarker["icon"]) {
  if (icon === "tool") {
    return <WrenchIcon />;
  }

  if (icon === "warning") {
    return <TriangleAlertIcon />;
  }

  return <InfoIcon />;
}

function ThreadMarker({ item }: { item: DesignMarker }) {
  return (
    <Marker variant="separator">
      <MarkerIcon>{getMarkerIcon(item.icon)}</MarkerIcon>
      <MarkerContent className="flex items-center justify-center gap-2">
        <span>{item.text}</span>
        {item.status ? <Badge variant="secondary">{item.status}</Badge> : null}
      </MarkerContent>
    </Marker>
  );
}

function MessageAttachments({ message }: { message: DesignMessage }) {
  if (message.attachments.length === 0) {
    return null;
  }

  return (
    <AttachmentGroup>
      {message.attachments.map((attachment) => (
        <Attachment key={attachment.id} state="done" size="sm">
          <AttachmentMedia variant={attachment.dataUrl ? "image" : "icon"}>
            {attachment.dataUrl ? (
              <img src={attachment.dataUrl} alt={attachment.title} />
            ) : (
              <FileImageIcon />
            )}
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{attachment.title}</AttachmentTitle>
            <AttachmentDescription>
              {attachment.description}
            </AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}

function ThreadMessage({
  item,
  onRestartEdited,
  showTimings,
}: {
  item: DesignMessage;
  /** Set ONLY on the initial user prompt: enables edit-and-restart (a new
   * session re-sent with the edited text). */
  onRestartEdited?: (text: string) => void;
  showTimings?: boolean;
}) {
  const align = item.role === "user" ? "end" : "start";
  const sender = item.role === "user" ? copy.userSender : copy.assistantSender;
  const bubbleVariant = item.role === "user" ? "default" : "secondary";
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(item.text);

  function beginEdit() {
    setEditText(item.text);
    setEditing(true);
  }

  return (
    <MessageGroup>
      <Message align={align}>
        <MessageAvatar>
          <Avatar className="size-8">
            <AvatarFallback>
              {item.role === "user"
                ? copy.userAvatarFallback
                : copy.assistantAvatarFallback}
            </AvatarFallback>
          </Avatar>
        </MessageAvatar>
        <MessageContent>
          <MessageHeader className="flex items-center gap-1.5">
            {sender}
            {item.anchor ? (
              // Conversation-routed asks: the message is SCOPED to a canvas
              // selection — the pin chip is the visual anchor.
              <Badge
                variant="secondary"
                className="max-w-48 gap-1 truncate font-normal"
                title={item.anchor.label}
              >
                <MapPinIcon className="size-3 shrink-0" />
                <span className="truncate">{item.anchor.label}</span>
              </Badge>
            ) : null}
            <ElapsedChip at={item.at} show={showTimings} />
            {onRestartEdited && !editing ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-5 text-muted-foreground"
                title={copy.editAndRestart}
                aria-label={copy.editAndRestart}
                onClick={beginEdit}
              >
                <PencilIcon className="size-3" />
              </Button>
            ) : null}
          </MessageHeader>
          <MessageAttachments message={item} />
          {editing && onRestartEdited ? (
            <div className="flex w-full flex-col gap-1.5">
              <textarea
                className="min-h-24 w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
                value={editText}
                onChange={(changeEvent) => setEditText(changeEvent.target.value)}
                aria-label={copy.editAndRestart}
              />
              <div className="flex items-center gap-1.5 self-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(false)}
                >
                  {copy.editCancel}
                </Button>
                <Button
                  size="sm"
                  disabled={!editText.trim()}
                  onClick={() => {
                    setEditing(false);
                    onRestartEdited(editText.trim());
                  }}
                >
                  <RefreshCwIcon className="size-3" />
                  {copy.editRestart}
                </Button>
              </div>
            </div>
          ) : (
            <Bubble variant={bubbleVariant} align={align}>
              <BubbleContent>
                {item.text ? (
                  <span className="whitespace-pre-wrap">{item.text}</span>
                ) : (
                  <span className="shimmer">{copy.thinking}</span>
                )}
              </BubbleContent>
            </Bubble>
          )}
          {item.status ? <MessageFooter>{item.status}</MessageFooter> : null}
        </MessageContent>
      </Message>
    </MessageGroup>
  );
}

/** The collapsed one-line summary — the LAST entry of the run, claude.ai-style:
 * the first line of the last thinking snippet, or `Running/Ran <tool>`. */
function getActivitySummary(activity: DesignActivity): string {
  const last = activity.entries[activity.entries.length - 1];

  if (!last) {
    return copy.activityWorked;
  }

  if (last.type === "tool") {
    const verb =
      last.status === "running" ? copy.activityRunning : copy.activityRan;
    return last.detail
      ? `${verb} ${last.name} · ${last.detail}`
      : `${verb} ${last.name}`;
  }

  const firstLine = last.text.trim().split("\n")[0]?.trim();
  return firstLine || copy.activityThinking;
}

function ActivityEntryStatus({
  status,
}: {
  status: "running" | "done" | "error";
}) {
  if (status === "running") {
    return <Spinner className="size-3 text-muted-foreground" />;
  }

  if (status === "error") {
    return <TriangleAlertIcon className="size-3 text-destructive" />;
  }

  return <CheckIcon className="size-3 text-muted-foreground" />;
}

function ActivityEntryRow({
  entry,
  showTimings,
}: {
  entry: ActivityEntry;
  showTimings?: boolean;
}) {
  if (entry.type === "thinking") {
    return (
      <div className="flex items-start gap-1.5">
        <SparklesIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/70" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-muted-foreground">
          {entry.text.trim()}
        </p>
        <ElapsedChip at={entry.at} show={showTimings} />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <WrenchIcon className="size-3 shrink-0 text-muted-foreground/70" />
      <span className="shrink-0 font-mono text-foreground/80">
        {entry.name}
      </span>
      {entry.detail ? (
        <span className="truncate font-mono text-muted-foreground/80">
          {entry.detail}
        </span>
      ) : null}
      <ActivityEntryStatus status={entry.status} />
      <span className="ml-auto flex shrink-0 items-center">
        <ElapsedChip at={entry.at} show={showTimings} />
      </span>
    </div>
  );
}

/**
 * A claude.ai-style collapsed "activity" row: one subdued line summarizing a run
 * of thinking + tool calls, expandable into the ordered list. Replaces the empty
 * "Thinking…" bubbles a thinking/tool-only turn used to produce. Collapsed by
 * default; expansion is local state keyed by `item.id`, so it survives the
 * re-renders a streaming turn triggers.
 */
function ThreadActivity({
  item,
  showTimings,
}: {
  item: DesignActivity;
  showTimings?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = item.status === "running";

  return (
    <div className="px-1 py-0.5 text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className={cn(
          "flex w-full items-center gap-1 text-left text-muted-foreground transition-colors hover:text-foreground",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className={cn("truncate", isRunning && "shimmer")}>
          {getActivitySummary(item)}
        </span>
      </button>
      {expanded ? (
        <div className="mt-1.5 ml-[7px] flex flex-col gap-1.5 border-l pl-3">
          {item.entries.map((entry, index) => (
            <ActivityEntryRow
              key={entry.type === "tool" ? entry.id : `thinking-${index}`}
              entry={entry}
              showTimings={showTimings}
            />
          ))}
          {isRunning ? null : (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <CheckIcon className="size-3 shrink-0" />
              <span>{copy.activityDone}</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Fallback rendering for a conversation-anchored variants row when the
 * host surface supplies no card renderer (e.g. the plain drawer chat):
 * the transcript note as a subdued info block. */
function VariantsRowFallback({ item }: { item: DesignVariantsRow }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <span className="whitespace-pre-wrap">{item.text}</span>
    </div>
  );
}

function ThreadItemView({
  item,
  onRestartEdited,
  showTimings,
  renderVariantsRow,
}: {
  item: ThreadItem;
  onRestartEdited?: (text: string) => void;
  showTimings?: boolean;
  /** Conversation-routed asks: the host renders a variants row as live
   * VARIANT CARDS (ChatPanel supplies this — it owns the sandbox api). */
  renderVariantsRow?: (item: DesignVariantsRow) => ReactNode;
}) {
  if (item.kind === "marker") {
    return <ThreadMarker item={item} />;
  }

  if (item.kind === "activity") {
    return <ThreadActivity item={item} showTimings={showTimings} />;
  }

  if (item.kind === "turn") {
    // G2 history row: the turn's commit range — diff + restore affordances.
    return <TurnChangesRow item={item} />;
  }

  if (item.kind === "variants") {
    // Conversation-anchored variant cards (conversation-routed asks).
    return <>{renderVariantsRow?.(item) ?? <VariantsRowFallback item={item} />}</>;
  }

  return (
    <ThreadMessage
      item={item}
      onRestartEdited={onRestartEdited}
      showTimings={showTimings}
    />
  );
}

function DesignChat({
  embedded,
  selectedNode,
  draft,
  onDraftChange,
  onPromptIntercept,
  viewingTurn,
  renderVariantsRow,
}: {
  embedded?: boolean;
  selectedNode?: CanvasNodeSelection;
  /** Controlled prompt draft. Uncontrolled if unset. */
  draft?: string;
  onDraftChange?: (draft: string) => void;
  /**
   * When set, a submitted prompt routes through the caller's pipeline INSTEAD
   * of /api/prompt — the proto full-view chat panel supplies this while a
   * frame selection exists, so a selection-scoped prompt reaches the SAME
   * conversation session with its fresh capture + pin anchor attached
   * (conversation-routed asks; one connected chat system, no second
   * composer). An error result restores the draft and surfaces a marker.
   */
  onPromptIntercept?: (message: string) => Promise<{ error?: string }>;
  /** CHAT TIME-TRAVEL: the parked turn of this conversation's changeset —
   * items after its turn row collapse behind a marker (display only). */
  viewingTurn?: { turn: string; changesetId?: string };
  /** Conversation-anchored variants rows → live variant cards (host-owned). */
  renderVariantsRow?: (item: DesignVariantsRow) => ReactNode;
}) {
  const [state, setState] = useState<DesignState>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [threadItems, setThreadItems] = useState<ThreadItem[]>([
    emptyThreadMarker,
  ]);
  // The prompt draft is controlled by the parent when `draft`/`onDraftChange`
  // are provided (so it survives a reload); otherwise it's local state.
  const [internalPrompt, setInternalPrompt] = useState("");
  const prompt = draft ?? internalPrompt;
  const setPrompt = onDraftChange ?? setInternalPrompt;
  const [queueMode, setQueueMode] = useState<"followUp" | "steer">("followUp");
  const [isBusy, setIsBusy] = useState(false);
  // Selected-node marker expansion: shows the FULL assembled context the next
  // send will include (informed confirm gate). Subscribed so async
  // selection-context fragments patch into the preview as they resolve.
  const [contextExpanded, setContextExpanded] = useState(false);
  const contextSnapshot = useSyncExternalStore(
    subscribeSelectionContext,
    getSelectionContextSnapshot,
    getSelectionContextSnapshot,
  );
  const assembledContext = selectedNode
    ? buildCanvasContextBlock(selectedNode, buildSelectionContextBlock())
    : undefined;
  const [connectionStatus, setConnectionStatus] = useState("Connecting");
  const streamingAssistantIdRef = useRef<string | undefined>(undefined);
  // The open activity run for the live turn: thinking deltas + tool executions
  // fold into ONE collapsed row (per contiguous run), mirroring the restore
  // path's grouping. Set at agent_start, completed at agent_end.
  const activityIdRef = useRef<string | undefined>(undefined);
  // Elapsed-time origin (epoch ms of the session's first message) for the
  // `+12.4s` chips. Restored threads compute theirs in messagesToThreadItems;
  // this ref serves the LIVE folds, seeded from the same first timestamp.
  const sessionStartRef = useRef<number | undefined>(undefined);
  // Branch-session scoping (per-branch-sessions spec): the thread is bound to
  // the ACTIVE branch's session. `undefined` = primary (wire compat), matching
  // the pre-registry behavior until the first `state` event arrives.
  const sessionBranchRef = useRef<string | undefined>(undefined);
  // G2 history rows: the live conversation's landed commit ranges (sidecar
  // turn records), woven into the thread as expandable diff/restore rows.
  const [turnRows, setTurnRows] = useState<DesignTurn[]>([]);
  const conversationIdRef = useRef<string | undefined>(undefined);
  const selectedModelValue = state?.model
    ? getModelValue(state.model)
    : undefined;
  // No provider credential anywhere: the session came up modelless AND the
  // available-model list is empty. Chat can't send, so the footer swaps the
  // prompt input for a setup callout (everything else in the workbench still
  // works). `models.length` keeps the input when auth exists but the restored
  // session's model is merely missing — the model select handles that case.
  const needsModelSetup =
    state !== undefined && !state.model && models.length === 0;

  async function fetchModels() {
    try {
      const response = await fetch(apiUrl("/api/models"));
      const payload = (await response.json()) as { models?: ModelOption[] };
      setModels(payload.models ?? []);
    } catch {
      setModels([]);
    }
  }

  useEffect(() => {
    void fetchModels();

    /** Fold one full session state into the thread (the SSE `state` handler
     * and the mount-time seed fetch share it). */
    let cancelled = false;
    let sawSseState = false;
    let sawSseOpen = false;
    function applyState(nextState: DesignState) {
      sessionBranchRef.current = nextState.branch;
      sessionStartRef.current = nextState.messages.find(
        (message) => message.timestamp,
      )?.timestamp;
      setState(nextState);
      setIsBusy(nextState.isStreaming);
      setThreadItems(messagesToThreadItems(nextState.messages));
      setConnectionStatus("Connected");
      if (conversationIdRef.current !== nextState.conversationId) {
        conversationIdRef.current = nextState.conversationId;
        refreshTurnRows(nextState.conversationId);
      }
    }

    // SEED: the shared /api/events stream replays `state` only on CONNECT,
    // and the bus outlives this component — a chat mounted later (full-view
    // chat tab) would wait forever for the next broadcast. Fetch once; the
    // first real SSE state wins over a slow seed.
    void fetch(apiUrl("/api/state"))
      .then((response) => (response.ok ? response.json() : undefined))
      .then((payload?: DesignState) => {
        if (!cancelled && payload && !sawSseState) applyState(payload);
      })
      .catch(() => {
        // Unreachable server — the SSE status handler reports it.
      });

    // G2: seed/refresh the conversation's turn records (commit ranges).
    function refreshTurnRows(conversationId: string | undefined) {
      if (!conversationId) {
        setTurnRows([]);
        return;
      }
      void fetch(
        apiUrl(
          `/api/sandbox/turns?conversationId=${encodeURIComponent(conversationId)}`,
        ),
      )
        .then((response) => response.json())
        .then((payload: { turns?: ConversationTurnWire[] }) => {
          if (conversationIdRef.current !== conversationId) return;
          setTurnRows(turnRowsFromWire(payload.turns ?? []));
        })
        .catch(() => {
          // No server / legacy server — the thread stays row-free.
        });
    }

    const unsubscribes = [
      subscribeApiEvents("state", (messageEvent) => {
      sawSseState = true;
      applyState(JSON.parse(messageEvent.data as string) as DesignState);
      }),

      // G2 history rows: a landed conversation turn announces its commit
      // range — grow the thread's diff/restore row without a refetch.
      subscribeApiEvents("sandbox-event", (messageEvent) => {
      let event: ConversationTurnWire & { type?: string };
      try {
        event = JSON.parse(messageEvent.data as string) as ConversationTurnWire & {
          type?: string;
        };
      } catch {
        return;
      }
      if (
        event.type === "conversation-turn" &&
        event.conversationId &&
        event.conversationId === conversationIdRef.current
      ) {
        setTurnRows((current) => upsertTurnRecord(current, event));
      }
      // Round-2 labels: generated async after the turn lands — update the
      // matching row in place (no refetch).
      if (event.type === "turn-label") {
        setTurnRows((current) =>
          applyTurnLabel(
            current,
            event as { turn?: string; changesetId?: string; label?: string },
          ),
        );
      }
      }),

      subscribeApiEvents("pi-event", (messageEvent) => {
      const event = JSON.parse(messageEvent.data as string) as PiEvent;

      // Drop events from OTHER branches' sessions: an inactive branch's
      // streaming turn must not corrupt this thread. Those surface only as
      // branch-switcher badges (see useWorktrees). Absent branch = primary.
      if (event.branch !== sessionBranchRef.current) {
        return;
      }

      // Elapsed ms since the session's first message (prefer the event's own
      // timestamp; fall back to arrival time). First message of a fresh
      // session seeds the origin, so its chip reads +0ms.
      function elapsedAt(timestamp?: number): number | undefined {
        if (sessionStartRef.current === undefined) {
          sessionStartRef.current = timestamp ?? Date.now();
        }
        return (timestamp ?? Date.now()) - sessionStartRef.current;
      }

      if (event.type === "agent_start") {
        setIsBusy(true);
        // Open a fresh activity run for this turn's thinking/tool folds.
        activityIdRef.current = `activity-live-${Date.now()}`;
      }

      if (event.type === "agent_end") {
        setIsBusy(false);
        streamingAssistantIdRef.current = undefined;
        const activityId = activityIdRef.current;
        if (activityId) {
          setThreadItems((currentItems) =>
            completeActivity(currentItems, activityId, "done"),
          );
        }
        activityIdRef.current = undefined;
      }

      if (event.type === "message_start" && event.message) {
        const started = toLiveMessage(event.message, `${Date.now()}`);

        if (!started) {
          return;
        }

        const liveMessage: DesignMessage = {
          ...started,
          at: elapsedAt(event.message.timestamp),
        };

        if (liveMessage.role === "assistant") {
          streamingAssistantIdRef.current = liveMessage.id;
          // An assistant turn opens with no text — its thinking/tool blocks
          // stream into the activity row, not a bubble. Upserting the empty
          // message here would show the old stuck "Thinking…" bubble, so only
          // create the bubble once there's text/attachments (see message_update
          // / message_end). User messages still render immediately.
          if (!liveMessage.text && liveMessage.attachments.length === 0) {
            return;
          }
        }

        setThreadItems((currentItems) =>
          upsertMessage(currentItems, liveMessage),
        );
      }

      if (event.type === "message_update") {
        const delta = event.assistantMessageEvent?.delta;
        const updateType = event.assistantMessageEvent?.type;

        // Thinking chunks fold into the live activity run (they never form a
        // bubble). appendActivityEntry extends the run's last thinking entry,
        // so the streamed block accretes rather than fragmenting per delta.
        if (delta && updateType === "thinking_delta") {
          const activityId =
            activityIdRef.current ?? `activity-live-${Date.now()}`;
          activityIdRef.current = activityId;
          const at = elapsedAt();
          setThreadItems((currentItems) =>
            appendActivityEntry(
              currentItems,
              { type: "thinking", text: delta, at },
              activityId,
            ),
          );
          return;
        }

        if (!delta || updateType !== "text_delta") {
          return;
        }

        const id =
          streamingAssistantIdRef.current ?? `assistant-stream-${Date.now()}`;
        streamingAssistantIdRef.current = id;

        const streamAt = elapsedAt();
        setThreadItems((currentItems) => {
          const existing = currentItems.find(
            (item): item is DesignMessage =>
              item.kind === "message" && item.id === id,
          );

          return upsertMessage(currentItems, {
            kind: "message",
            id,
            role: "assistant",
            text: `${existing?.text ?? ""}${delta}`,
            attachments: existing?.attachments ?? [],
            status: "Streaming",
            // The FIRST text delta stamps the bubble's elapsed time.
            at: existing?.at ?? streamAt,
          });
        });
      }

      if (event.type === "message_end" && event.message) {
        const fallbackId = streamingAssistantIdRef.current ?? `${Date.now()}`;
        const ended = toLiveMessage(event.message, fallbackId);

        if (!ended) {
          return;
        }

        const liveMessage: DesignMessage = {
          ...ended,
          at: elapsedAt(event.message.timestamp),
        };

        const message =
          event.message.role === "assistant" && streamingAssistantIdRef.current
            ? {
                ...liveMessage,
                id: streamingAssistantIdRef.current,
                status: undefined,
              }
            : liveMessage;

        const errorText = event.message.errorMessage;
        // Empty assistant messages never become bubbles: a thinking/tool-only
        // turn lives entirely in its activity row, and a failed turn's empty
        // message would leave a bubble stuck on the "Thinking…" shimmer.
        const isEmpty = !message.text && message.attachments.length === 0;
        const dropEmpty =
          event.message.role === "assistant" && isEmpty;
        const activityId = activityIdRef.current;

        setThreadItems((currentItems) => {
          // Keep the streaming bubble's first-delta chip — message_end fires
          // at the END of the turn's message.
          const existing = currentItems.find(
            (item): item is DesignMessage =>
              item.kind === "message" && item.id === message.id,
          );
          const finalMessage = { ...message, at: existing?.at ?? message.at };
          let nextItems = dropEmpty
            ? currentItems.filter(
                (item) => !(item.kind === "message" && item.id === message.id),
              )
            : upsertMessage(currentItems, finalMessage);

          if (errorText) {
            // Mark the turn's activity run errored, then surface the marker.
            if (activityId) {
              nextItems = completeActivity(nextItems, activityId, "error");
            }
            nextItems = upsertMarker(nextItems, {
              kind: "marker",
              id: `turn-error-${message.id}`,
              icon: "warning",
              status: "error",
              text: errorText,
            });
          }

          return nextItems;
        });

        if (event.message.role === "assistant") {
          streamingAssistantIdRef.current = undefined;
        }
      }

      if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_end"
      ) {
        // Tool executions fold into the live activity run as one entry each,
        // upserted by id so start→end flips running→done/error in place.
        const status =
          event.type === "tool_execution_start"
            ? "running"
            : event.isError
              ? "error"
              : "done";
        const activityId =
          activityIdRef.current ?? `activity-live-${Date.now()}`;
        activityIdRef.current = activityId;
        // Only the start event stamps `at` — the upsert keeps it on the flip.
        const at =
          event.type === "tool_execution_start" ? elapsedAt() : undefined;
        setThreadItems((currentItems) =>
          appendActivityEntry(
            currentItems,
            toToolEntry(event, status, at),
            activityId,
          ),
        );
      }
      }),

      subscribeApiEvents("server-notice", (messageEvent) => {
      const payload = JSON.parse(messageEvent.data as string) as {
        message?: string;
      };

      if (!payload.message) {
        return;
      }

      setThreadItems((currentItems) =>
        upsertMarker(currentItems, {
          kind: "marker",
          id: `notice-${Date.now()}`,
          icon: "info",
          text: payload.message ?? "",
        }),
      );
      }),

      subscribeApiEvents("server-error", (messageEvent) => {
      const payload = JSON.parse(messageEvent.data as string) as {
        message?: string;
      };

      setThreadItems((currentItems) =>
        upsertMarker(currentItems, {
          kind: "marker",
          id: `error-${Date.now()}`,
          icon: "warning",
          status: "error",
          text: payload.message ?? "The design agent server reported an error.",
        }),
      );
      }),

      subscribeConnectionStatus((status) => {
        setConnectionStatus(status === "open" ? "Connected" : "Disconnected");
        // G4 staleness fix: `conversation-turn` events missed while the
        // shared stream was released (hidden tab) or down are gone — every
        // RECONNECT refetches the rows (the sidecar records are the truth).
        if (status === "open") {
          if (sawSseOpen) refreshTurnRows(conversationIdRef.current);
          sawSseOpen = true;
        }
      }),
    ];

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, []);

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const message = prompt.trim();

    if (!message) {
      return;
    }

    setPrompt("");

    // Interception seam (proto full-view): a selection-scoped prompt routes
    // through the sandbox pin machinery instead of the main-chat session.
    if (onPromptIntercept) {
      const interceptError = (await onPromptIntercept(message)).error;
      if (interceptError) {
        setThreadItems((currentItems) =>
          upsertMarker(currentItems, {
            kind: "marker",
            id: `prompt-error-${Date.now()}`,
            icon: "warning",
            status: "error",
            text: interceptError,
          }),
        );
        setPrompt(message);
      }
      return;
    }

    // Send-time assembly: the selection-context registry's resolved prompt
    // fragments (whatever has resolved by now) become the context block; the
    // legacy per-field lines are only the empty-registry fallback.
    const messageWithContext = buildPromptWithCanvasContext(
      message,
      selectedNode,
      buildSelectionContextBlock(),
    );

    const response = await fetch(apiUrl("/api/prompt"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: messageWithContext,
        streamingBehavior: isBusy ? queueMode : undefined,
      }),
    });

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setThreadItems((currentItems) =>
        upsertMarker(currentItems, {
          kind: "marker",
          id: `prompt-error-${Date.now()}`,
          icon: "warning",
          status: "error",
          text: payload.error ?? "Unable to send the message.",
        }),
      );
      setPrompt(message);
    }
  }

  async function abortTurn() {
    await fetch(apiUrl("/api/abort"), { method: "POST" });
  }

  // The thread's FIRST user message — the only one that offers edit-and-restart
  // (Pi transcripts are append-only, so "editing" = new session + re-send).
  const initialPromptId = threadItems.find(
    (item): item is DesignMessage =>
      item.kind === "message" && item.role === "user",
  )?.id;

  /**
   * Edit-and-restart: start a FRESH session, then re-send the edited text
   * verbatim. No context re-assembly — the stored message already contains
   * whatever context block the original send composed, and the user just
   * edited exactly what they see.
   */
  async function restartWithEditedPrompt(text: string) {
    await startNewConversation();
    const response = await fetch(apiUrl("/api/prompt"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setThreadItems((currentItems) =>
        upsertMarker(currentItems, {
          kind: "marker",
          id: `prompt-error-${Date.now()}`,
          icon: "warning",
          status: "error",
          text: payload.error ?? "Unable to send the message.",
        }),
      );
    }
  }

  async function startNewConversation() {
    const response = await fetch(apiUrl("/api/new-session"), {
      method: "POST",
    });

    if (!response.ok) {
      setThreadItems((currentItems) =>
        upsertMarker(currentItems, {
          kind: "marker",
          id: `new-session-error-${Date.now()}`,
          icon: "warning",
          status: "error",
          text: copy.newConversationError,
        }),
      );
      return;
    }

    // The server broadcasts a fresh "state" event which resets the thread to
    // the empty-conversation marker; just clear local input/streaming refs.
    setPrompt("");
    streamingAssistantIdRef.current = undefined;
  }

  /**
   * Recovery path for the no-model callout: a new session re-reads
   * `~/.pi/agent/auth.json` on the server (see api.ts createSession), so a
   * `pi /login` done after launch is picked up without restarting.
   */
  async function retryModelSetup() {
    await startNewConversation();
    await fetchModels();
  }

  async function selectModel(value: string) {
    const { provider, modelId } = parseModelValue(value);

    if (!provider || !modelId) {
      return;
    }

    const response = await fetch(apiUrl("/api/model"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, modelId }),
    });

    if (!response.ok) {
      setThreadItems((currentItems) =>
        upsertMarker(currentItems, {
          kind: "marker",
          id: `model-error-${Date.now()}`,
          icon: "warning",
          status: "error",
          text: copy.switchModelError,
        }),
      );
    }
  }

  return (
    <MessageScrollerProvider autoScroll>
      <Card
        className={cn(
          "flex w-full overflow-hidden py-0",
          embedded
            ? "h-full rounded-none border-0 shadow-none"
            : "mx-auto h-[calc(100vh-2rem)] max-w-5xl",
        )}
      >
        <CardHeader className="border-b py-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            {embedded ? null : (
              <div className="flex min-w-0 flex-col gap-2">
                <CardTitle className="flex items-center gap-2">
                  <BotIcon />
                  {copy.appTitle}
                </CardTitle>
                <CardDescription>{copy.appDescription}</CardDescription>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{connectionStatus}</Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void startNewConversation();
                }}
              >
                <PlusIcon />
                {copy.newConversation}
              </Button>
              <Field
                orientation="horizontal"
                className="w-full gap-2 md:w-auto"
              >
                <FieldLabel htmlFor="design-agent-model" className="sr-only">
                  {copy.modelFieldLabel}
                </FieldLabel>
                <Select
                  value={selectedModelValue}
                  onValueChange={(value) => {
                    void selectModel(value);
                  }}
                  disabled={isBusy || models.length === 0}
                >
                  <SelectTrigger
                    id="design-agent-model"
                    size="sm"
                    className="max-w-64"
                  >
                    <SelectValue placeholder={copy.modelPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{copy.modelFieldLabel}</SelectLabel>
                      {models.map((model) => (
                        <SelectItem
                          key={getModelValue(model)}
                          value={getModelValue(model)}
                        >
                          {model.name ?? model.id}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {isBusy ? (
                <Badge>
                  <Spinner data-icon="inline-start" />
                  {copy.working}
                </Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 px-0">
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent aria-busy={isBusy} className="p-6">
                {truncateThreadForViewing(
                  insertTurnRows(threadItems, turnRows),
                  viewingTurn,
                ).map((item) => (
                  <MessageScrollerItem
                    key={item.id}
                    messageId={item.id}
                    scrollAnchor={
                      item.kind === "message" && item.role === "user"
                    }
                  >
                    <ThreadItemView
                      item={item}
                      onRestartEdited={
                        item.id === initialPromptId
                          ? restartWithEditedPrompt
                          : undefined
                      }
                      showTimings={state?.showTimings}
                      renderVariantsRow={renderVariantsRow}
                    />
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3 border-t py-4">
          {selectedNode ? (
            <Marker variant="border" className="rounded-md p-2">
              <MarkerIcon>
                <InfoIcon />
              </MarkerIcon>
              <MarkerContent className="grid gap-1">
                <span className="flex items-center gap-2 font-medium">
                  {copy.selectedNodeContextLabel}
                  {contextSnapshot.pending > 0 ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {copy.selectedNodeContextPending}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="ml-auto text-xs font-normal underline underline-offset-2 hover:no-underline"
                    onClick={() => setContextExpanded((current) => !current)}
                  >
                    {contextExpanded
                      ? copy.selectedNodeHideContext
                      : copy.selectedNodeShowContext}
                  </button>
                </span>
                {contextExpanded ? (
                  <pre className="max-h-48 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
                    {assembledContext}
                  </pre>
                ) : (
                  <span
                    className="truncate font-mono text-xs"
                    title={formatSelectionMarkerSummary(selectedNode)}
                  >
                    {formatSelectionMarkerSummary(selectedNode)}
                  </span>
                )}
                <span className="text-xs">{copy.selectedNodeHelp}</span>
              </MarkerContent>
            </Marker>
          ) : null}
          {needsModelSetup ? (
            <div
              className="grid gap-2 rounded-md border p-3 text-sm"
              role="status"
              data-testid="chat-model-setup"
            >
              <span className="font-medium">{copy.noModelTitle}</span>
              <span className="text-muted-foreground">{copy.noModelBody}</span>
              <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
                <li>
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    npx designbook login
                  </code>{" "}
                  {copy.noModelLoginHint}
                </li>
                <li>
                  {copy.noModelEnvHint}{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                    ANTHROPIC_API_KEY=…
                  </code>
                </li>
              </ul>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={() => {
                  void retryModelSetup();
                }}
              >
                <RefreshCwIcon />
                {copy.noModelRetry}
              </Button>
            </div>
          ) : (
            <form onSubmit={submitPrompt}>
              <FieldGroup>
                <Field>
                  <FieldLabel
                    htmlFor={CHAT_PROMPT_INPUT_ID}
                    className="sr-only"
                  >
                    {copy.messageFieldLabel}
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupTextarea
                      id={CHAT_PROMPT_INPUT_ID}
                      value={prompt}
                      rows={2}
                      // Cap growth (field-sizing-content) so a long drafted
                      // prompt — e.g. a Figma pull handoff — scrolls instead of
                      // swallowing the panel.
                      className="max-h-48 overflow-y-auto"
                      placeholder={copy.promptPlaceholder}
                      onChange={(event) => setPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          event.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                    <InputGroupAddon align="block-end" className="gap-2">
                      {isBusy ? (
                        <ToggleGroup
                          type="single"
                          value={queueMode}
                          onValueChange={(value) => {
                            if (value === "followUp" || value === "steer") {
                              setQueueMode(value);
                            }
                          }}
                          aria-label={copy.messageDeliveryModeLabel}
                          spacing={1}
                        >
                          <ToggleGroupItem value="followUp" size="sm">
                            {copy.followUpMode}
                          </ToggleGroupItem>
                          <ToggleGroupItem value="steer" size="sm">
                            {copy.steerMode}
                          </ToggleGroupItem>
                        </ToggleGroup>
                      ) : null}
                      <InputGroupButton
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        disabled={!isBusy}
                        onClick={() => {
                          void abortTurn();
                        }}
                      >
                        <SquareIcon />
                        <span className="sr-only">
                          {copy.abortCurrentResponse}
                        </span>
                      </InputGroupButton>
                      <InputGroupButton
                        type="submit"
                        variant="default"
                        size="icon-sm"
                        disabled={!prompt.trim()}
                        className="ml-auto"
                      >
                        <SendIcon />
                        <span className="sr-only">{copy.sendMessage}</span>
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
              </FieldGroup>
            </form>
          )}
          <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
            <span className="truncate">
              {copy.agentCwdLabel} {state?.cwd ?? copy.starting}
            </span>
            {state?.sessionId ? (
              <Badge variant="outline">
                {copy.sessionLabel} {state.sessionId.slice(0, 8)}
                {state.branchName ? ` · ${state.branchName}` : null}
              </Badge>
            ) : null}
          </div>
        </CardFooter>
      </Card>
    </MessageScrollerProvider>
  );
}

export { CHAT_PROMPT_INPUT_ID, DesignChat };
