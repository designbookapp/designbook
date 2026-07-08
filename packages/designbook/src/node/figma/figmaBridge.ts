/**
 * The Figma bridge: a WebSocket relay between designbook and a running Figma
 * plugin. Figma plugins cannot listen on a socket, so the plugin's UI iframe
 * opens the connection *outbound* to us — designbook is the WS server, the
 * plugin is the client. Only one plugin connection is supported at a time; a
 * new `hello` replaces whatever socket was previously attached.
 *
 * Wire protocol:
 *   plugin -> server (on connect):  { type: "hello", protocol, fileKey, fileName, page, user }
 *   server -> plugin:               { type: "invoke", id, tool, params }
 *   plugin -> server:               { type: "result", id, ok: true,  data }
 *                                    { type: "result", id, ok: false, error: { code, message } }
 *   plugin -> server (unsolicited): { type: "event", name, data }
 * Unknown `type` values are logged and ignored.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

/**
 * The subset of the `ws` `WebSocket` interface the bridge relies on. A real
 * `ws.WebSocket` satisfies this structurally; unit tests pass a plain mock
 * object instead of standing up a real socket/server.
 */
interface MinimalSocket {
  readyState: number;
  on(event: "message", listener: (data: { toString(): string }) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  removeAllListeners(): void;
  close(): void;
  send(data: string): void;
}

type HelloInfo = {
  protocol: number;
  fileKey?: string;
  fileName?: string;
  page?: string;
  user?: string;
};

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ConnectionChangeCallback = (connected: boolean) => void;
type EventCallback = (name: string, data: unknown) => void;

type ResultMessage = {
  type: "result";
  id: number;
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
};

type HelloMessage = {
  type: "hello";
  protocol?: number;
  fileKey?: string;
  fileName?: string;
  page?: string;
  user?: string;
};

type EventMessage = {
  type: "event";
  name: string;
  data?: unknown;
};

function createFigmaBridge() {
  const wss = new WebSocketServer({ noServer: true });

  let socket: MinimalSocket | undefined;
  let helloInfo: HelloInfo | undefined;
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

  const connectionChangeCallbacks = new Set<ConnectionChangeCallback>();
  const eventCallbacks = new Set<EventCallback>();

  function log(message: string) {
    console.log(`[designbook] ${new Date().toISOString()} [figma] ${message}`);
  }

  function notifyConnectionChange(connected: boolean) {
    for (const cb of connectionChangeCallbacks) cb(connected);
  }

  function rejectAllPending(reason: string) {
    for (const [, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    pending.clear();
  }

  function detachSocket() {
    if (!socket) return;
    socket.removeAllListeners();
    socket = undefined;
    helloInfo = undefined;
    rejectAllPending("Figma plugin disconnected.");
    notifyConnectionChange(false);
  }

  function handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log(`received malformed JSON, ignoring: ${raw.slice(0, 200)}`);
      return;
    }

    const envelope = parsed as { type?: unknown };
    if (!envelope || typeof envelope.type !== "string") {
      log(`received message with no type, ignoring`);
      return;
    }

    switch (envelope.type) {
      case "hello": {
        const hello = parsed as HelloMessage;
        helloInfo = {
          protocol: typeof hello.protocol === "number" ? hello.protocol : 1,
          fileKey: hello.fileKey,
          fileName: hello.fileName,
          page: hello.page,
          user: hello.user,
        };
        log(
          `hello received (file: ${helloInfo.fileName ?? "unknown"}, page: ${helloInfo.page ?? "unknown"})`,
        );
        notifyConnectionChange(true);
        return;
      }
      case "result": {
        const result = parsed as ResultMessage;
        const request = pending.get(result.id);
        if (!request) {
          log(`received result for unknown id ${result.id}, ignoring`);
          return;
        }
        pending.delete(result.id);
        clearTimeout(request.timer);
        if (result.ok) {
          request.resolve(result.data);
        } else {
          request.reject(
            new Error(result.error?.message ?? "Figma plugin reported an error."),
          );
        }
        return;
      }
      case "event": {
        const event = parsed as EventMessage;
        for (const cb of eventCallbacks) cb(event.name, event.data);
        return;
      }
      default:
        log(`received unknown message type "${envelope.type}", ignoring`);
    }
  }

  /** Wires a new client socket, replacing any previous connection. */
  function attachSocket(newSocket: MinimalSocket) {
    if (socket && socket !== newSocket) {
      log("new plugin connection replacing previous one");
      socket.removeAllListeners();
      socket.close();
      rejectAllPending("Replaced by a new Figma plugin connection.");
    }

    socket = newSocket;
    helloInfo = undefined;

    newSocket.on("message", (data) => {
      handleMessage(data.toString());
    });

    newSocket.on("close", () => {
      if (socket === newSocket) {
        log("plugin disconnected");
        detachSocket();
      }
    });

    newSocket.on("error", (error) => {
      log(`socket error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Called from the http server's `upgrade` event for `/api/figma-bridge`. */
  function handleUpgrade(
    request: IncomingMessage,
    socketStream: Duplex,
    head: Buffer,
  ) {
    wss.handleUpgrade(request, socketStream, head, (ws) => {
      log("plugin connected");
      attachSocket(ws);
    });
  }

  function isConnected(): boolean {
    return socket !== undefined && socket.readyState === WebSocket.OPEN;
  }

  function getInfo(): HelloInfo | undefined {
    return helloInfo;
  }

  function onConnectionChange(cb: ConnectionChangeCallback): () => void {
    connectionChangeCallbacks.add(cb);
    return () => connectionChangeCallbacks.delete(cb);
  }

  function onEvent(cb: EventCallback): () => void {
    eventCallbacks.add(cb);
    return () => eventCallbacks.delete(cb);
  }

  function invoke(
    tool: string,
    params: unknown,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    if (!isConnected() || !socket) {
      return Promise.reject(
        new Error(
          "No Figma plugin connected. Open the designbook plugin in Figma.",
        ),
      );
    }

    const id = nextId++;
    const activeSocket = socket;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Figma plugin did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });

      try {
        activeSocket.send(JSON.stringify({ type: "invoke", id, tool, params }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return {
    handleUpgrade,
    invoke,
    isConnected,
    getInfo,
    onConnectionChange,
    onEvent,
    /**
     * Wires a client socket directly, bypassing the HTTP upgrade dance.
     * Exposed mainly so unit tests can drive the bridge with a mock socket
     * (no real `ws` server / no Figma required).
     */
    attachSocket,
  };
}

type FigmaBridge = ReturnType<typeof createFigmaBridge>;

export { createFigmaBridge };
export type { FigmaBridge };
