/**
 * Unit tests for the node-side integration registry (S1): route dispatch
 * (canonical + alias to the SAME handler), the mechanical --read-only write
 * set, bridge upgrade-path routing, and tool/skill/event aggregation.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  DeviceBridge,
  PluginNodeSpec,
} from "../../integration/index.ts";
import {
  canonicalRoutePath,
  createIntegrationRegistry,
} from "./registry.ts";

function fakeBridge(name: string): DeviceBridge {
  return {
    invoke: async () => undefined,
    isConnected: () => false,
    getInfo: () => undefined,
    onConnectionChange: () => () => {},
    onEvent: () => () => {},
    handleUpgrade: () => {},
    // Tag for assertions.
    ...({ __name: name } as object),
  } as DeviceBridge;
}

function registryWith(node: PluginNodeSpec, name = "figma") {
  const log = vi.fn();
  const registry = createIntegrationRegistry({
    integrations: [{ name, node }],
    createBridge: fakeBridge,
    log,
  });
  return { registry, log };
}

describe("canonicalRoutePath", () => {
  it("namespaces under /api/x/<name>/", () => {
    expect(canonicalRoutePath("figma", "status")).toBe("/api/x/figma/status");
    expect(canonicalRoutePath("figma", "/status")).toBe("/api/x/figma/status");
  });
});

describe("route dispatch", () => {
  it("dispatches canonical and alias paths to the same handler", () => {
    const handler = vi.fn();
    const { registry } = registryWith({
      routes: [
        {
          method: "GET",
          path: "status",
          aliases: ["/api/figma/status"],
          handler,
        },
      ],
    });

    const canonical = registry.match("GET", "/api/x/figma/status");
    const alias = registry.match("GET", "/api/figma/status");
    expect(canonical).toBeDefined();
    expect(alias).toBeDefined();
    expect(alias!.route.handler).toBe(canonical!.route.handler);
    expect(registry.match("POST", "/api/x/figma/status")).toBeUndefined();
    expect(registry.match("GET", "/api/x/figma/nope")).toBeUndefined();
  });

  it("keys routes by method so GET/POST/PUT on one path coexist", () => {
    const get = vi.fn();
    const put = vi.fn();
    const { registry } = registryWith({
      routes: [
        { method: "GET", path: "variables", handler: get },
        { method: "PUT", path: "variables", handler: put },
      ],
    });
    expect(registry.match("GET", "/api/x/figma/variables")!.route.handler).toBe(
      get,
    );
    expect(registry.match("PUT", "/api/x/figma/variables")!.route.handler).toBe(
      put,
    );
  });

  it("throws on a route collision across integrations", () => {
    expect(() =>
      createIntegrationRegistry({
        integrations: [
          {
            name: "a",
            node: {
              routes: [
                { method: "GET", path: "x", aliases: ["/api/shared"], handler: vi.fn() },
              ],
            },
          },
          {
            name: "b",
            node: {
              routes: [
                { method: "GET", path: "y", aliases: ["/api/shared"], handler: vi.fn() },
              ],
            },
          },
        ],
        createBridge: fakeBridge,
        log: vi.fn(),
      }),
    ).toThrow(/collision/);
  });
});

describe("write routes → --read-only block set", () => {
  it("collects write route keys for canonical AND alias paths", () => {
    const { registry } = registryWith({
      routes: [
        {
          method: "POST",
          path: "write-thing",
          aliases: ["/api/figma/write-thing"],
          write: true,
          handler: vi.fn(),
        },
        { method: "GET", path: "status", handler: vi.fn() },
      ],
    });
    expect([...registry.writeRouteKeys()].sort()).toEqual([
      "POST /api/figma/write-thing",
      "POST /api/x/figma/write-thing",
    ]);
  });
});

describe("device bridge", () => {
  it("routes upgrades only at /api/bridge/<name> and declared aliases", () => {
    const { registry } = registryWith({
      bridge: { protocol: 1, upgradeAliases: ["/api/figma-bridge"] },
    });
    expect(registry.bridgeForUpgradePath("/api/bridge/figma")).toBeDefined();
    expect(registry.bridgeForUpgradePath("/api/figma-bridge")).toBe(
      registry.bridgeForUpgradePath("/api/bridge/figma"),
    );
    expect(registry.bridgeForUpgradePath("/api/bridge/other")).toBeUndefined();
    expect(registry.bridgeForUpgradePath("/api/anything")).toBeUndefined();
  });

  it("passes the bridge to route ctx, piTools ctx, and events ctx", () => {
    const seen: unknown[] = [];
    const { registry } = registryWith({
      bridge: { protocol: 1 },
      routes: [{ method: "GET", path: "s", handler: vi.fn() }],
      piTools: (ctx) => {
        seen.push(ctx.bridge);
        return [];
      },
      events: (_broadcast, ctx) => {
        seen.push(ctx.bridge);
      },
    });
    registry.initEvents(vi.fn());
    const match = registry.match("GET", "/api/x/figma/s");
    seen.push(match!.ctx.bridge);
    const bridge = registry.bridgeForUpgradePath("/api/bridge/figma");
    expect(seen).toEqual([bridge, bridge, bridge]);
  });

  it("creates no bridge when the spec doesn't request one", () => {
    const { registry } = registryWith({
      routes: [{ method: "GET", path: "s", handler: vi.fn() }],
    });
    expect(registry.bridgeForUpgradePath("/api/bridge/figma")).toBeUndefined();
    expect(registry.match("GET", "/api/x/figma/s")!.ctx.bridge).toBeUndefined();
  });
});

describe("aggregation", () => {
  it("aggregates piTools, skillsDirs, and events across integrations", () => {
    const toolA = { name: "a_tool" } as never;
    const toolB = { name: "b_tool" } as never;
    const eventsA = vi.fn();
    const registry = createIntegrationRegistry({
      integrations: [
        {
          name: "a",
          node: { piTools: () => [toolA], skillsDir: "/pkg/a/skills", events: eventsA },
        },
        { name: "b", node: { piTools: () => [toolB] } },
      ],
      createBridge: fakeBridge,
      log: vi.fn(),
    });
    expect(registry.piTools()).toEqual([toolA, toolB]);
    expect(registry.skillsDirs()).toEqual(["/pkg/a/skills"]);
    const broadcast = vi.fn();
    registry.initEvents(broadcast);
    expect(eventsA).toHaveBeenCalledWith(broadcast, expect.objectContaining({ log: expect.any(Function) }));
  });

  it("prefixes ctx.log with the integration name", () => {
    const log = vi.fn();
    const registry = createIntegrationRegistry({
      integrations: [
        {
          name: "figma",
          node: { events: (_b, ctx) => ctx.log("hello") },
        },
      ],
      createBridge: fakeBridge,
      log,
    });
    registry.initEvents(vi.fn());
    expect(log).toHaveBeenCalledWith("[figma] hello");
  });
});
