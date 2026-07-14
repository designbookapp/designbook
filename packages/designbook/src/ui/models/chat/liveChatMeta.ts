/**
 * Live chat metadata off the `state` SSE: first user message (list-row
 * title), last message timestamp (list ordering), and the live session's
 * conversation id (L3 grouping + active-conversation reporting).
 *
 * Extracted from the page-mode drawer (PageToolsDrawer, retired with the
 * collapsed-toolbar experience) — the full view's chat panel and its
 * active-conversation reporter are the consumers now.
 */

import { useEffect, useState } from "react";
import { apiUrl } from "@designbook-ui/designbook";
import { subscribeApiEvents } from "@designbook-ui/models/events/eventBus";
import { firstUserText } from "@designbook-ui/models/chat/threadRows";

type LiveChatMeta = {
  firstMessage?: string;
  lastActivityAt?: number;
  conversationId?: string;
};

/** One wire `state` payload → the meta slice. */
function liveChatMetaFromState(state: {
  conversationId?: string;
  messages?: Array<{
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    timestamp?: number;
  }>;
}): LiveChatMeta {
  const timestamps = (state.messages ?? [])
    .map((message) => message.timestamp)
    .filter((at): at is number => typeof at === "number");
  return {
    firstMessage: firstUserText(state.messages),
    ...(timestamps.length > 0
      ? { lastActivityAt: Math.max(...timestamps) }
      : {}),
    ...(typeof state.conversationId === "string" && state.conversationId
      ? { conversationId: state.conversationId }
      : {}),
  };
}

function useLiveChatMeta(): LiveChatMeta {
  const [meta, setMeta] = useState<LiveChatMeta>({});
  useEffect(() => {
    // The bus's `state` event fires at CONNECT time — a component mounting
    // later (the threads list, the active-conversation reporter) would miss
    // it, so seed with a one-shot fetch; the subscription keeps it fresh.
    let cancelled = false;
    void fetch(apiUrl("/api/state"))
      .then((response) => response.json())
      .then((state: Parameters<typeof liveChatMetaFromState>[0]) => {
        if (!cancelled) setMeta(liveChatMetaFromState(state));
      })
      .catch(() => {});
    const unsubscribe = subscribeApiEvents("state", (messageEvent) => {
      try {
        setMeta(
          liveChatMetaFromState(
            JSON.parse(messageEvent.data as string) as Parameters<
              typeof liveChatMetaFromState
            >[0],
          ),
        );
      } catch {
        // Malformed state event — keep the previous meta.
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return meta;
}

export { liveChatMetaFromState, useLiveChatMeta };
export type { LiveChatMeta };
