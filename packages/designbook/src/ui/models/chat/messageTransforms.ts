import type {
  DesignAttachment,
  DesignMessage,
  RawAgentMessage,
  RawContent,
  RawImageContent,
  ThreadItem,
} from "./types";

function isTextContent(
  content: RawContent,
): content is Extract<RawContent, { type: "text" }> {
  return content.type === "text";
}

function isImageContent(content: RawContent): content is RawImageContent {
  return content.type === "image";
}

function getImageDataUrl(content: RawImageContent) {
  const data = content.data ?? content.source?.data;
  const mimeType = content.mimeType ?? content.source?.mediaType ?? "image/png";

  if (!data) {
    return undefined;
  }

  return `data:${mimeType};base64,${data}`;
}

function getMessageText(message: RawAgentMessage) {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter(isTextContent)
    .map((content) => content.text)
    .join("\n");
}

function getMessageAttachments(
  message: RawAgentMessage,
  messageId: string,
): DesignAttachment[] {
  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content.filter(isImageContent).map((content, index) => ({
    id: `${messageId}-attachment-${index}`,
    title: `Image ${index + 1}`,
    description:
      content.mimeType ?? content.source?.mediaType ?? "Image attachment",
    dataUrl: getImageDataUrl(content),
  }));
}

function toDesignMessage(
  message: RawAgentMessage,
  index: number,
): DesignMessage | undefined {
  if (message.role !== "assistant" && message.role !== "user") {
    return undefined;
  }

  const id = `${message.role}-${message.timestamp ?? "existing"}-${index}`;

  return {
    kind: "message",
    id,
    role: message.role,
    text: getMessageText(message),
    attachments: getMessageAttachments(message, id),
  };
}

function messagesToThreadItems(messages: RawAgentMessage[]) {
  const items: ThreadItem[] = [];

  messages.forEach((message, index) => {
    const designMessage = toDesignMessage(message, index);
    // A failed turn's assistant message is empty; rendering it would show a
    // bubble stuck on the "Thinking…" shimmer, so surface the error instead.
    const isEmptyErrored =
      Boolean(message.errorMessage) &&
      designMessage?.role === "assistant" &&
      !designMessage.text &&
      designMessage.attachments.length === 0;

    if (designMessage && !isEmptyErrored) {
      items.push(designMessage);
    }
    if (message.errorMessage) {
      items.push({
        kind: "marker",
        id: `turn-error-${index}`,
        icon: "warning",
        status: "error",
        text: message.errorMessage,
      });
    }
  });

  return items.length > 0
    ? items
    : [
        {
          kind: "marker",
          id: "empty-thread",
          icon: "info",
          text: "Start a conversation with the Pi coding agent.",
        } satisfies ThreadItem,
      ];
}

export { getMessageAttachments, getMessageText, messagesToThreadItems };
