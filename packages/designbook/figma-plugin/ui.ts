/**
 * designbook Figma plugin — UI iframe.
 *
 * Figma plugins can't open sockets from the main thread, so this iframe
 * owns the WebSocket connection to designbook and relays everything to/from
 * the main thread (code.ts) via `postMessage`.
 *
 * Flow:
 *   1. Probe http://localhost:<8787..8797>/api/figma-hello for the
 *      designbook identity JSON.
 *   2. Open ws://localhost:<port>/api/figma-bridge and send `hello`.
 *   3. Relay `invoke` (server -> us) to the main thread as `execute`, and
 *      relay the main thread's `executeResult` back to the server as
 *      `result`. Relay the main thread's `event` messages straight through.
 */

type InitMessage = {
  type: "init";
  fileKey?: string;
  fileName?: string;
  page?: string;
  user?: string;
};

type EventFromMain = {
  type: "event";
  name: string;
  data: unknown;
};

type ExecuteResultFromMain = {
  type: "executeResult";
  requestId: number;
  ok: boolean;
  data?: unknown;
  error?: { message?: string };
};

type MainMessage = InitMessage | EventFromMain | ExecuteResultFromMain;

type InvokeFromServer = {
  type: "invoke";
  id: number;
  tool: string;
  params: unknown;
};

const PORT_RANGE_START = 8787;
const PORT_RANGE_END = 8797;
const PROBE_TIMEOUT_MS = 800;
const RECONNECT_DELAY_MS = 2000;

const dotEl = document.getElementById("dot");
const statusTextEl = document.getElementById("statusText");

function setStatus(text: string, state: "searching" | "connected" | "disconnected") {
  if (statusTextEl) statusTextEl.textContent = text;
  if (dotEl) dotEl.className = `dot ${state === "connected" ? "connected" : state === "searching" ? "searching" : ""}`;
}

let socket: WebSocket | undefined;
let initInfo: InitMessage | undefined;
let stopped = false;

window.onmessage = (event: MessageEvent) => {
  const msg = (event.data as { pluginMessage?: MainMessage } | undefined)?.pluginMessage;
  if (!msg) return;

  if (msg.type === "init") {
    initInfo = msg;
    return;
  }

  if (msg.type === "event") {
    sendToServer({ type: "event", name: msg.name, data: msg.data });
    return;
  }

  if (msg.type === "executeResult") {
    sendToServer({
      type: "result",
      id: msg.requestId,
      ok: msg.ok,
      data: msg.data,
      error: msg.error,
    });
    return;
  }
};

function sendToServer(payload: unknown) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function postToMain(message: unknown) {
  parent.postMessage({ pluginMessage: message }, "*");
}

async function probeOnce(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://localhost:${port}/api/figma-hello`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const identity = (await response.json()) as { app?: string };
    return identity?.app === "designbook";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeAndConnect() {
  if (stopped) return;
  setStatus("Searching for designbook…", "searching");

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await probeOnce(port)) {
      connect(port);
      return;
    }
  }

  setStatus("Could not find designbook. Retrying…", "disconnected");
  setTimeout(probeAndConnect, RECONNECT_DELAY_MS);
}

function connect(port: number) {
  setStatus(`Connecting to designbook on ${port}…`, "searching");
  const ws = new WebSocket(`ws://localhost:${port}/api/figma-bridge`);
  socket = ws;

  ws.onopen = () => {
    setStatus(`Connected to designbook (${initInfo?.fileName ?? "file"})`, "connected");
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 1,
        fileKey: initInfo?.fileKey,
        fileName: initInfo?.fileName,
        page: initInfo?.page,
        user: initInfo?.user,
      }),
    );
  };

  ws.onmessage = (event) => {
    let msg: InvokeFromServer | undefined;
    try {
      msg = JSON.parse(event.data as string) as InvokeFromServer;
    } catch {
      return;
    }
    if (msg?.type === "invoke") {
      postToMain({ type: "execute", requestId: msg.id, tool: msg.tool, params: msg.params });
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = undefined;
    setStatus("Disconnected from designbook. Retrying…", "disconnected");
    setTimeout(probeAndConnect, RECONNECT_DELAY_MS);
  };

  ws.onerror = () => {
    // onclose fires right after; the retry loop there is sufficient.
  };
}

probeAndConnect();
