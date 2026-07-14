/**
 * Canonical `chat` model fixtures.
 *
 * ONE hardcoded session — a running Pi session with a user turn and an assistant
 * reply — used by the model's unit tests AND (later) by cells that render the
 * chat drawer without a live server. `createChatFixture` returns a fresh dataset
 * each call whose `send`/`abort`/`newSession`/`selectModel` append to shared
 * logs so a consumer can assert routing.
 */

import { messagesToThreadItems } from "./messageTransforms";
import type { ChatData } from "./chatModel";
import type { DesignState, ModelOption, RawAgentMessage } from "./types";

type ChatFixture = {
  /** Feed straight into `<ChatProvider data={...}>` or `createChatModel`. */
  data: ChatData;
  /** Every message sent, in order. */
  sent: string[];
  /** Count of abort() calls. */
  aborts: number;
  /** Count of newSession() calls. */
  newSessions: number;
  /** Every model select value chosen, in order. */
  models: string[];
  send: (message: string) => void;
  abort: () => void;
  newSession: () => void;
  selectModel: (value: string) => void;
  /** The raw agent messages behind the thread, for transform assertions. */
  rawMessages: RawAgentMessage[];
  /** The model option the fixture session is on. */
  model: ModelOption;
};

const MODEL: ModelOption = {
  id: "opus-4",
  name: "Claude Opus 4",
  provider: "anthropic",
  reasoning: true,
};

// A realistic turn: the user asks, the agent thinks + runs two tools (a run
// that COALESCES into one collapsed "activity" row — 2 thinking entries + 2
// tool calls, each resolved by a `toolResult`), then answers with text. Shapes
// mirror the Pi transcript: assistant `thinking`/`toolCall` blocks + separate
// `toolResult` messages carrying `toolCallId`/`isError`.
const RAW_MESSAGES: RawAgentMessage[] = [
  { role: "user", content: "Tighten the product card spacing.", timestamp: 1 },
  {
    role: "assistant",
    timestamp: 2,
    content: [
      {
        type: "thinking",
        thinking: "Let me find where the product card sets its gap.",
      },
      {
        type: "toolCall",
        id: "call-grep-1",
        name: "bash",
        arguments: { command: "rg -n 'ProductCard' src/composite" },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "call-grep-1",
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: "Card.tsx:12: gap-4" }],
    timestamp: 3,
  },
  {
    role: "assistant",
    timestamp: 4,
    content: [
      {
        type: "thinking",
        thinking: "It's `gap-4` (16px). I'll drop it to `gap-2` (8px).",
      },
      {
        type: "toolCall",
        id: "call-edit-1",
        name: "edit",
        arguments: { path: "src/composite/product/variants/Card.tsx" },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "call-edit-1",
    toolName: "edit",
    isError: false,
    content: [{ type: "text", text: "Successfully replaced 1 block." }],
    timestamp: 5,
  },
  {
    role: "assistant",
    content: "Done — reduced the product card gap to 8px.",
    timestamp: 6,
  },
];

function createChatFixture(): ChatFixture {
  const sent: string[] = [];
  const models: string[] = [];
  const state: DesignState = {
    cwd: "/repo",
    isStreaming: false,
    messages: RAW_MESSAGES.map((message) => ({ ...message })),
    model: MODEL,
    sessionId: "sess-1234abcd",
    thinkingLevel: "medium",
  };
  const fixture: ChatFixture = {
    data: {
      state,
      threadItems: messagesToThreadItems(state.messages),
    },
    sent,
    aborts: 0,
    newSessions: 0,
    models,
    send: (message) => sent.push(message),
    abort: () => {
      fixture.aborts += 1;
    },
    newSession: () => {
      fixture.newSessions += 1;
    },
    selectModel: (value) => models.push(value),
    rawMessages: state.messages,
    model: MODEL,
  };
  return fixture;
}

export { createChatFixture };
export type { ChatFixture };
