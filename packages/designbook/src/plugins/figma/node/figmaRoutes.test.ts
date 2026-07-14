/**
 * The figma node routes the props-panel section drives — push/pull/status —
 * exercised against a FAKED device bridge (no real Figma plugin). Mirrors the
 * fake-bridge pattern in src/node/integration/registry.test.ts: a connected
 * bridge relays the request to a `figma_*` tool; a disconnected one answers 409
 * so the section can gray out its actions instead of surfacing a 500.
 */

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type {
  DeviceBridge,
  IntegrationRouteCtx,
  PluginRoute,
} from "../../../integration/index.ts";
import { figmaNode } from "./index.ts";

type FakeBridgeOptions = {
  connected?: boolean;
  invoke?: DeviceBridge["invoke"];
  info?: ReturnType<DeviceBridge["getInfo"]>;
};

function fakeBridge(options: FakeBridgeOptions = {}): DeviceBridge {
  return {
    invoke: options.invoke ?? (async () => undefined),
    isConnected: () => options.connected ?? false,
    getInfo: () => options.info,
    onConnectionChange: () => () => {},
    onEvent: () => () => {},
    handleUpgrade: () => {},
  } as DeviceBridge;
}

/** Captured response — status + parsed JSON body. */
type Captured = { status: number; body: unknown };

function fakeResponse(captured: Captured): ServerResponse {
  return {
    writeHead(status: number) {
      captured.status = status;
      return this as unknown as ServerResponse;
    },
    end(chunk?: string) {
      captured.body = chunk ? JSON.parse(chunk) : undefined;
      return this as unknown as ServerResponse;
    },
  } as unknown as ServerResponse;
}

function fakeRequest(body?: unknown): IncomingMessage {
  const json = body === undefined ? "" : JSON.stringify(body);
  return Readable.from([json]) as unknown as IncomingMessage;
}

function routeFor(method: string, path: string): PluginRoute {
  const route = (figmaNode().routes ?? []).find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!route) throw new Error(`no ${method} ${path} route`);
  return route;
}

function ctxWith(bridge: DeviceBridge): IntegrationRouteCtx {
  return { bridge, log: vi.fn() };
}

async function invokeRoute(
  method: string,
  path: string,
  bridge: DeviceBridge,
  body?: unknown,
): Promise<Captured> {
  const captured: Captured = { status: 0, body: undefined };
  await routeFor(method, path).handler(
    fakeRequest(body),
    fakeResponse(captured),
    new URL(`http://x/api/x/figma/${path}`),
    ctxWith(bridge),
  );
  return captured;
}

describe("figma status route", () => {
  it("reports the bridge connection + info", async () => {
    const bridge = fakeBridge({
      connected: true,
      info: { protocol: 1, fileName: "Kit", page: "Cards" },
    });
    const res = await invokeRoute("GET", "status", bridge);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: true,
      info: { protocol: 1, fileName: "Kit", page: "Cards" },
    });
  });

  it("reports disconnected with null info", async () => {
    const res = await invokeRoute("GET", "status", fakeBridge());
    expect(res.body).toEqual({ connected: false, info: null });
  });
});

describe("figma push route", () => {
  it("relays the serialized tree to figma_render_nodes", async () => {
    const invoke = vi.fn(async () => ({ nodeId: "1:2", created: true }));
    const bridge = fakeBridge({ connected: true, invoke });
    const tree = { componentId: "product.ProductCard", root: {} };
    const res = await invokeRoute("POST", "push", bridge, { tree });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nodeId: "1:2", created: true });
    expect(invoke).toHaveBeenCalledWith("figma_render_nodes", { tree }, 60_000);
  });

  it("409s when no plugin is connected", async () => {
    const res = await invokeRoute("POST", "push", fakeBridge(), {
      tree: { componentId: "x" },
    });
    expect(res.status).toBe(409);
  });

  it("400s a body missing a componentId'd tree", async () => {
    const bridge = fakeBridge({ connected: true, invoke: vi.fn() });
    const res = await invokeRoute("POST", "push", bridge, { tree: {} });
    expect(res.status).toBe(400);
  });
});

describe("figma pull route", () => {
  it("returns the annotated HTML for a pushed component", async () => {
    const invoke = vi.fn(async () => ({
      html: "<div data-component='x'></div>",
      render: { locale: "en-US" },
    }));
    const bridge = fakeBridge({ connected: true, invoke });
    const res = await invokeRoute("POST", "pull", bridge, {
      componentId: "product.ProductCard",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      componentId: "product.ProductCard",
      html: "<div data-component='x'></div>",
    });
    expect(invoke).toHaveBeenCalledWith(
      "figma_read_html",
      { componentId: "product.ProductCard" },
      60_000,
    );
  });

  it("409s when no plugin is connected", async () => {
    const res = await invokeRoute("POST", "pull", fakeBridge(), {
      componentId: "x",
    });
    expect(res.status).toBe(409);
  });

  it("400s when componentId is missing", async () => {
    const bridge = fakeBridge({ connected: true, invoke: vi.fn() });
    const res = await invokeRoute("POST", "pull", bridge, {});
    expect(res.status).toBe(400);
  });

  it("404s when the component was never pushed ([not-found] marker)", async () => {
    const bridge = fakeBridge({
      connected: true,
      invoke: vi.fn(async () => {
        throw new Error("[not-found] no pushed frame for x");
      }),
    });
    const res = await invokeRoute("POST", "pull", bridge, { componentId: "x" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "no pushed frame for x" });
  });
});
