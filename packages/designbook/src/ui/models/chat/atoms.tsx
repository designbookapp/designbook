/**
 * `chat` model atoms: the small, declarative pieces a chat surface
 * or a cell composes over a `ThreadItem`. Thin — the chat model's substance is
 * the thread transform pipeline + the injected session actions (chatModel.ts) —
 * so these exist only so a cell can render a thread item's gist without reaching
 * into the (shadcn-heavy) `DesignChat` surface, and so that rendering has ONE
 * home.
 *
 * `useChatModel` (re-exported from ChatProvider) is the context hook the surface
 * uses to reach the pipeline + actions.
 */

import type { DesignMessage, ThreadItem } from "./types";
import { useChatModel } from "./ChatProvider";

/** A message's text, or the "Thinking…" placeholder while it streams empty. */
function MessageText({ message }: { message: DesignMessage }) {
  return <>{message.text || "Thinking…"}</>;
}

/** Whether a thread item is a user (vs. assistant / marker) message. */
function isUserMessage(item: ThreadItem): boolean {
  return item.kind === "message" && item.role === "user";
}

/** The current thread on the provider (the empty-state marker in empty mode). */
function useThread(): ThreadItem[] {
  return useChatModel().threadItems;
}

export { MessageText, isUserMessage, useThread, useChatModel };
