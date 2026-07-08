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

const RAW_MESSAGES: RawAgentMessage[] = [
  { role: "user", content: "Tighten the product card spacing.", timestamp: 1 },
  {
    role: "assistant",
    content: "On it — reducing the gap to 8px.",
    timestamp: 2,
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
