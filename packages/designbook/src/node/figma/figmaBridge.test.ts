import { describe, expect, it, vi } from "vitest";
import { createFigmaBridge } from "./figmaBridge.ts";

/**
 * A minimal stand-in for a `ws.WebSocket`, driven entirely in-process — no
 * real socket, no Figma. Captures listeners so tests can simulate inbound
 * messages, and records sent frames so tests can assert on outbound ones.
 */
function createMockSocket() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const sent: unknown[] = [];

  const socket = {
    readyState: 1, // WebSocket.OPEN
    on(event: string, listener: (...args: any[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    removeAllListeners() {
      listeners.clear();
    },
    close() {
      emit("close");
    },
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  };

  function emit(event: string, ...args: unknown[]) {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  }

  function emitMessage(payload: unknown) {
    emit("message", { toString: () => JSON.stringify(payload) });
  }

  return { socket, sent, emit, emitMessage };
}

describe("figmaBridge", () => {
  it("rejects invoke when no plugin is connected", async () => {
    const bridge = createFigmaBridge();
    expect(bridge.isConnected()).toBe(false);
    await expect(bridge.invoke("figma_get_selection", {})).rejects.toThrow(
      /no figma plugin connected/i,
    );
  });

  it("stores hello metadata and reports connected", () => {
    const bridge = createFigmaBridge();
    const { socket, emitMessage } = createMockSocket();

    bridge.attachSocket(socket);
    emitMessage({
      type: "hello",
      protocol: 1,
      fileKey: "abc123",
      fileName: "My File",
      page: "Page 1",
      user: "Ada",
    });

    expect(bridge.isConnected()).toBe(true);
    expect(bridge.getInfo()).toEqual({
      protocol: 1,
      fileKey: "abc123",
      fileName: "My File",
      page: "Page 1",
      user: "Ada",
    });
  });

  it("fires the connection-change callback on hello and on disconnect", () => {
    const bridge = createFigmaBridge();
    const { socket, emit, emitMessage } = createMockSocket();
    const onChange = vi.fn();
    bridge.onConnectionChange(onChange);

    bridge.attachSocket(socket);
    emitMessage({ type: "hello", protocol: 1 });
    expect(onChange).toHaveBeenLastCalledWith(true);

    emit("close");
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(bridge.isConnected()).toBe(false);
  });

  it("routes an invoke round-trip: sends invoke, resolves on matching result", async () => {
    const bridge = createFigmaBridge();
    const { socket, sent, emitMessage } = createMockSocket();
    bridge.attachSocket(socket);
    emitMessage({ type: "hello", protocol: 1 });

    const promise = bridge.invoke("figma_get_selection", { foo: "bar" });

    expect(sent).toHaveLength(1);
    const request = sent[0] as { type: string; id: number; tool: string };
    expect(request.type).toBe("invoke");
    expect(request.tool).toBe("figma_get_selection");

    emitMessage({ type: "result", id: request.id, ok: true, data: { nodes: [] } });

    await expect(promise).resolves.toEqual({ nodes: [] });
  });

  it("rejects the pending invoke when the plugin returns ok:false", async () => {
    const bridge = createFigmaBridge();
    const { socket, sent, emitMessage } = createMockSocket();
    bridge.attachSocket(socket);
    emitMessage({ type: "hello", protocol: 1 });

    const promise = bridge.invoke("figma_create_frame", {});
    const request = sent[0] as { id: number };

    emitMessage({
      type: "result",
      id: request.id,
      ok: false,
      error: { code: "bad_params", message: "width is required" },
    });

    await expect(promise).rejects.toThrow(/width is required/);
  });

  it("rejects a pending invoke after the timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      const bridge = createFigmaBridge();
      const { socket } = createMockSocket();
      bridge.attachSocket(socket);

      const promise = bridge.invoke("figma_get_selection", {}, 50);
      const assertion = expect(promise).rejects.toThrow(/did not respond/i);

      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores unknown message types without throwing", () => {
    const bridge = createFigmaBridge();
    const { socket, emitMessage } = createMockSocket();
    bridge.attachSocket(socket);

    expect(() => emitMessage({ type: "mystery", data: 1 })).not.toThrow();
    // Unknown types are ignored, not disconnecting; the socket is still live.
    expect(bridge.isConnected()).toBe(true);
  });

  it("re-broadcasts unsolicited events via onEvent", () => {
    const bridge = createFigmaBridge();
    const { socket, emitMessage } = createMockSocket();
    bridge.attachSocket(socket);

    const onEvent = vi.fn();
    bridge.onEvent(onEvent);

    emitMessage({
      type: "event",
      name: "selectionchange",
      data: { count: 2 },
    });

    expect(onEvent).toHaveBeenCalledWith("selectionchange", { count: 2 });
  });

  it("replaces an old connection when a new one attaches", () => {
    const bridge = createFigmaBridge();
    const first = createMockSocket();
    const second = createMockSocket();

    bridge.attachSocket(first.socket);
    first.emitMessage({ type: "hello", protocol: 1, fileName: "First" });
    expect(bridge.getInfo()?.fileName).toBe("First");

    bridge.attachSocket(second.socket);
    second.emitMessage({ type: "hello", protocol: 1, fileName: "Second" });
    expect(bridge.getInfo()?.fileName).toBe("Second");
  });
});
