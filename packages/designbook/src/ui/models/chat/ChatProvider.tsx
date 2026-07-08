/**
 * React binding for the `chat` model.
 *
 * `ChatProvider` builds a `ChatModel` (see chatModel.ts) and puts it on context
 * so chat surfaces + atoms read the session state / thread + send/abort/
 * new-session actions declaratively:
 *   - live use: `DesignChat` owns the SSE machine + React state (the stateful
 *     hook stays in the surface — confirmed altitude) and feeds this provider
 *     the current `state`/`threadItems` as `data` plus the bound fetch actions;
 *   - tests / cells: pass `data` (a fixture session); the actions default to
 *     no-ops.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  createChatModel,
  type ChatActions,
  type ChatData,
  type ChatModel,
} from "./chatModel";

const ChatModelContext = createContext<ChatModel | null>(null);

type ChatProviderProps = Partial<ChatActions> & {
  /** Live/fixture session state; omitted defaults to an empty thread. */
  data?: ChatData;
  children: ReactNode;
};

function ChatProvider({
  data,
  send,
  abort,
  newSession,
  selectModel,
  children,
}: ChatProviderProps) {
  const model = useMemo(
    () => createChatModel({ data, send, abort, newSession, selectModel }),
    [data, send, abort, newSession, selectModel],
  );
  return (
    <ChatModelContext.Provider value={model}>
      {children}
    </ChatModelContext.Provider>
  );
}

/** Read the chat model from context; throws if used outside a provider. */
function useChatModel(): ChatModel {
  const model = useContext(ChatModelContext);
  if (!model) {
    throw new Error("useChatModel must be used within a <ChatProvider>.");
  }
  return model;
}

export { ChatProvider, useChatModel, ChatModelContext };
export type { ChatProviderProps };
