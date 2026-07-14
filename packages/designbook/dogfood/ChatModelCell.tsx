/**
 * Dogfood cell for `models/chat` (R spec item 4). Wraps `ChatProvider` in
 * fixture mode (a running Pi session, one user turn + one assistant reply) and
 * renders the `MessageText`/`isUserMessage` atoms over the transformed thread —
 * the same pieces the chat drawer composes, with no live SSE stream.
 */
import { useMemo } from "react";
import { isUserMessage, MessageText, useThread } from "@designbook-ui/models/chat/atoms";
import { ChatProvider } from "@designbook-ui/models/chat/ChatProvider";
import { createChatFixture } from "@designbook-ui/models/chat/fixtures";
import { cn } from "@designbook-ui/lib/utils";
import { ModelCellFrame } from "./ModelCellFrame";

function ChatCellBody() {
  const thread = useThread();
  return (
    <ul className="space-y-2 text-sm">
      {thread.map((item) => (
        <li
          key={item.id}
          className={cn(
            "rounded-md border px-2 py-1.5",
            item.kind === "message" && isUserMessage(item)
              ? "bg-muted"
              : "bg-background",
          )}
        >
          {item.kind === "message" ? (
            <MessageText message={item} />
          ) : item.kind === "activity" ? (
            <span className="text-muted-foreground">
              {item.entries
                .map((entry) =>
                  entry.type === "tool" ? `[${entry.name}]` : entry.text,
                )
                .join(" · ")}
            </span>
          ) : (
            item.text
          )}
        </li>
      ))}
    </ul>
  );
}

function ChatModelCell() {
  const fixture = useMemo(() => createChatFixture(), []);
  return (
    <ChatProvider
      data={fixture.data}
      send={fixture.send}
      abort={fixture.abort}
      newSession={fixture.newSession}
      selectModel={fixture.selectModel}
    >
      <ModelCellFrame title="Pi session thread" model="models/chat">
        <ChatCellBody />
      </ModelCellFrame>
    </ChatProvider>
  );
}

export default ChatModelCell;
