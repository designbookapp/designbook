import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiUrl } from "@designbook-ui/designbook";
import {
  BotIcon,
  FileImageIcon,
  InfoIcon,
  PlusIcon,
  SendIcon,
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
import { Field, FieldGroup, FieldLabel } from "@designbook-ui/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@designbook-ui/components/ui/input-group";
import { Marker, MarkerContent, MarkerIcon } from "@designbook-ui/components/ui/marker";
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
import { ToggleGroup, ToggleGroupItem } from "@designbook-ui/components/ui/toggle-group";
import { cn } from "@designbook-ui/lib/utils";
import {
  buildPromptWithCanvasContext,
  emptyThreadMarker,
  getModelValue,
  getToolMarker,
  messagesToThreadItems,
  parseModelValue,
  toLiveMessage,
  upsertMarker,
  upsertMessage,
} from "@designbook-ui/models/chat/chatModel";
import type { CanvasNodeSelection } from "@designbook-ui/types";
import type {
  DesignMarker,
  DesignMessage,
  DesignState,
  ModelOption,
  PiEvent,
  ThreadItem,
} from "@designbook-ui/models/chat/types";

/** DOM id of the prompt textarea — exported so the workbench can focus it
 * after drafting a prompt into the chat tab (Figma pull handoff). */
const CHAT_PROMPT_INPUT_ID = "design-agent-prompt";

const copy = {
  abortCurrentResponse: "Abort current response",
  agentCwdLabel: "Agent cwd:",
  appDescription: "A local React interface for Pi powered by the Pi SDK.",
  appTitle: "Commerce Design Agent",
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
  selectedNodeContextLabel: "Selected node context",
  selectedNodeHelp: "This path will be included with your next message.",
  promptPlaceholder:
    "Ask Pi to inspect files, draft UI changes, or explain this workspace.",
  sendMessage: "Send message",
  sessionLabel: "Session",
  starting: "starting…",
  switchModelError: "Unable to switch model.",
  sourcePathLabel: "Source path:",
  steerMode: "Steer",
  thinking: "Thinking…",
  userAvatarFallback: "ME",
  userSender: "You",
  working: "Working",
};

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

function ThreadMessage({ item }: { item: DesignMessage }) {
  const align = item.role === "user" ? "end" : "start";
  const sender = item.role === "user" ? copy.userSender : copy.assistantSender;
  const bubbleVariant = item.role === "user" ? "default" : "secondary";

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
          <MessageHeader>{sender}</MessageHeader>
          <MessageAttachments message={item} />
          <Bubble variant={bubbleVariant} align={align}>
            <BubbleContent>
              {item.text ? (
                <span className="whitespace-pre-wrap">{item.text}</span>
              ) : (
                <span className="shimmer">{copy.thinking}</span>
              )}
            </BubbleContent>
          </Bubble>
          {item.status ? <MessageFooter>{item.status}</MessageFooter> : null}
        </MessageContent>
      </Message>
    </MessageGroup>
  );
}

function ThreadItemView({ item }: { item: ThreadItem }) {
  if (item.kind === "marker") {
    return <ThreadMarker item={item} />;
  }

  return <ThreadMessage item={item} />;
}

function DesignChat({
  embedded,
  selectedNode,
  draft,
  onDraftChange,
}: {
  embedded?: boolean;
  selectedNode?: CanvasNodeSelection;
  /** Controlled prompt draft. Uncontrolled if unset. */
  draft?: string;
  onDraftChange?: (draft: string) => void;
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
  const [connectionStatus, setConnectionStatus] = useState("Connecting");
  const streamingAssistantIdRef = useRef<string | undefined>(undefined);
  const selectedModelValue = state?.model
    ? getModelValue(state.model)
    : undefined;

  useEffect(() => {
    const eventSource = new EventSource(apiUrl("/api/events"));

    void fetch(apiUrl("/api/models"))
      .then(
        (response) => response.json() as Promise<{ models?: ModelOption[] }>,
      )
      .then((payload) => {
        setModels(payload.models ?? []);
      })
      .catch(() => {
        setModels([]);
      });

    eventSource.addEventListener("state", (messageEvent) => {
      const nextState = JSON.parse(messageEvent.data as string) as DesignState;
      setState(nextState);
      setIsBusy(nextState.isStreaming);
      setThreadItems(messagesToThreadItems(nextState.messages));
      setConnectionStatus("Connected");
    });

    eventSource.addEventListener("pi-event", (messageEvent) => {
      const event = JSON.parse(messageEvent.data as string) as PiEvent;

      if (event.type === "agent_start") {
        setIsBusy(true);
      }

      if (event.type === "agent_end") {
        setIsBusy(false);
        streamingAssistantIdRef.current = undefined;
      }

      if (event.type === "message_start" && event.message) {
        const liveMessage = toLiveMessage(event.message, `${Date.now()}`);

        if (!liveMessage) {
          return;
        }

        if (liveMessage.role === "assistant") {
          streamingAssistantIdRef.current = liveMessage.id;
        }

        setThreadItems((currentItems) =>
          upsertMessage(currentItems, liveMessage),
        );
      }

      if (event.type === "message_update") {
        const delta = event.assistantMessageEvent?.delta;
        const updateType = event.assistantMessageEvent?.type;

        if (!delta || updateType !== "text_delta") {
          return;
        }

        const id =
          streamingAssistantIdRef.current ?? `assistant-stream-${Date.now()}`;
        streamingAssistantIdRef.current = id;

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
          });
        });
      }

      if (event.type === "message_end" && event.message) {
        const fallbackId = streamingAssistantIdRef.current ?? `${Date.now()}`;
        const liveMessage = toLiveMessage(event.message, fallbackId);

        if (!liveMessage) {
          return;
        }

        const message =
          event.message.role === "assistant" && streamingAssistantIdRef.current
            ? {
                ...liveMessage,
                id: streamingAssistantIdRef.current,
                status: undefined,
              }
            : liveMessage;

        const errorText = event.message.errorMessage;
        // A failed turn ends with an empty assistant message; upserting it
        // would leave a bubble stuck on the "Thinking…" shimmer.
        const dropEmptyErrored =
          Boolean(errorText) &&
          !message.text &&
          message.attachments.length === 0;

        setThreadItems((currentItems) => {
          let nextItems = dropEmptyErrored
            ? currentItems.filter(
                (item) => !(item.kind === "message" && item.id === message.id),
              )
            : upsertMessage(currentItems, message);

          if (errorText) {
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

      if (event.type === "tool_execution_start") {
        setThreadItems((currentItems) =>
          upsertMarker(currentItems, getToolMarker(event, "running")),
        );
      }

      if (event.type === "tool_execution_end") {
        setThreadItems((currentItems) =>
          upsertMarker(
            currentItems,
            getToolMarker(event, event.isError ? "error" : "done"),
          ),
        );
      }
    });

    eventSource.addEventListener("server-notice", (messageEvent) => {
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
    });

    eventSource.addEventListener("server-error", (messageEvent) => {
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
    });

    eventSource.addEventListener("open", () => {
      setConnectionStatus("Connected");
    });

    eventSource.addEventListener("error", () => {
      setConnectionStatus("Disconnected");
    });

    return () => {
      eventSource.close();
    };
  }, []);

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const message = prompt.trim();

    if (!message) {
      return;
    }

    setPrompt("");
    const messageWithContext = buildPromptWithCanvasContext(
      message,
      selectedNode,
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

  async function startNewConversation() {
    const response = await fetch(apiUrl("/api/new-session"), { method: "POST" });

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
                {threadItems.map((item) => (
                  <MessageScrollerItem
                    key={item.id}
                    messageId={item.id}
                    scrollAnchor={
                      item.kind === "message" && item.role === "user"
                    }
                  >
                    <ThreadItemView item={item} />
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
                <span className="font-medium">
                  {copy.selectedNodeContextLabel}
                </span>
                <span className="truncate font-mono text-xs">
                  {copy.sourcePathLabel} {selectedNode.path}
                </span>
                <span className="text-xs">{copy.selectedNodeHelp}</span>
              </MarkerContent>
            </Marker>
          ) : null}
          <form onSubmit={submitPrompt}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={CHAT_PROMPT_INPUT_ID} className="sr-only">
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
          <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
            <span className="truncate">
              {copy.agentCwdLabel} {state?.cwd ?? copy.starting}
            </span>
            {state?.sessionId ? (
              <Badge variant="outline">
                {copy.sessionLabel} {state.sessionId.slice(0, 8)}
              </Badge>
            ) : null}
          </div>
        </CardFooter>
      </Card>
    </MessageScrollerProvider>
  );
}

export { CHAT_PROMPT_INPUT_ID, DesignChat };
