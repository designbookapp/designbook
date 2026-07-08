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
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
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
};

type DesignMarker = {
  kind: "marker";
  id: string;
  icon: "info" | "tool" | "warning";
  text: string;
  status?: "running" | "done" | "error";
};

type ThreadItem = DesignMarker | DesignMessage;

type ModelOption = {
  contextWindow?: number;
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
};

type DesignState = {
  cwd: string;
  isStreaming: boolean;
  messages: RawAgentMessage[];
  model?: ModelOption | null;
  sessionFile?: string;
  sessionId: string;
  thinkingLevel: string;
};

type PiEvent = {
  type?: string;
  message?: RawAgentMessage;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  error?: string;
  result?: {
    content?: RawContent[];
  };
};

export type {
  DesignAttachment,
  DesignMessage,
  DesignMarker,
  DesignState,
  ModelOption,
  PiEvent,
  RawAgentMessage,
  RawContent,
  RawImageContent,
  ThreadItem,
};
