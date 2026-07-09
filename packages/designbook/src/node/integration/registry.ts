/**
 * Node-side integration registry: turns the registered integrations' node
 * specs into the tables the server consumes —
 *
 *   - a route table keyed `"METHOD <pathname>"`, canonical
 *     (`/api/x/<name>/<path>`) and alias paths dispatching to the SAME handler;
 *   - the `--read-only` write-route key set (write routes, canonical + alias);
 *   - the aggregated Pi tool list and packaged-skills dirs;
 *   - WS-upgrade routing for core device bridges (`/api/bridge/<name>` plus
 *     each spec's declared legacy aliases) — the ONLY upgrade surface
 *     integrations get;
 *   - event wiring onto the workbench SSE broadcast.
 *
 * Pure over its inputs (bridge creation is injected) so it is unit-testable
 * without a server.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  DeviceBridge,
  IntegrationRouteCtx,
  PluginNodeSpec,
  PluginRoute,
} from "../../integration/index.ts";

/** A registered node half: the plugin name plus its node spec. */
type NodeIntegration = {
  name: string;
  node: PluginNodeSpec;
};

type RegistryOptions = {
  integrations: NodeIntegration[];
  /** Creates a device bridge for a spec that requests one (core-owned). */
  createBridge: (name: string) => DeviceBridge;
  log: (message: string) => void;
};

type RouteMatch = {
  route: PluginRoute;
  ctx: IntegrationRouteCtx;
};

/** Canonical route pathname for an integration route. */
function canonicalRoutePath(integrationName: string, routePath: string): string {
  const trimmed = routePath.replace(/^\/+/, "");
  return `/api/x/${integrationName}/${trimmed}`;
}

function routeKey(method: string, pathname: string): string {
  return `${method} ${pathname}`;
}

function createIntegrationRegistry(options: RegistryOptions) {
  const { integrations, createBridge, log } = options;

  const routesByKey = new Map<string, RouteMatch>();
  const writeRouteKeys = new Set<string>();
  const bridges = new Map<string, DeviceBridge>();
  const upgradeBridgeByPath = new Map<string, DeviceBridge>();
  const tools: ToolDefinition[] = [];
  const skillsDirs: string[] = [];
  const eventHooks: Array<{
    events: NonNullable<PluginNodeSpec["events"]>;
    ctx: IntegrationRouteCtx;
  }> = [];

  for (const { name, node } of integrations) {
    const ctx: IntegrationRouteCtx = {
      log: (message) => log(`[${name}] ${message}`),
    };

    if (node.bridge) {
      const bridge = createBridge(name);
      bridges.set(name, bridge);
      ctx.bridge = bridge;
      upgradeBridgeByPath.set(`/api/bridge/${name}`, bridge);
      for (const alias of node.bridge.upgradeAliases ?? []) {
        upgradeBridgeByPath.set(alias, bridge);
      }
    }

    for (const route of node.routes ?? []) {
      const paths = [
        canonicalRoutePath(name, route.path),
        ...(route.aliases ?? []),
      ];
      for (const pathname of paths) {
        const key = routeKey(route.method, pathname);
        if (routesByKey.has(key)) {
          throw new Error(
            `[designbook] integration route collision: ${key} (integration "${name}")`,
          );
        }
        routesByKey.set(key, { route, ctx });
        if (route.write) writeRouteKeys.add(key);
      }
    }

    if (node.piTools) tools.push(...node.piTools(ctx));
    if (node.skillsDir) skillsDirs.push(node.skillsDir);
    if (node.events) eventHooks.push({ events: node.events, ctx });
  }

  return {
    /** The route for `METHOD pathname`, or undefined (canonical or alias). */
    match(method: string, pathname: string): RouteMatch | undefined {
      return routesByKey.get(routeKey(method, pathname));
    },
    /** `"METHOD pathname"` keys blocked in --read-only (canonical + alias). */
    writeRouteKeys(): ReadonlySet<string> {
      return writeRouteKeys;
    },
    /**
     * The device bridge accepting a WS upgrade at `pathname` (canonical
     * `/api/bridge/<name>` or a declared alias), or undefined. The caller
     * must strip any `/__designbook` namespace first.
     */
    bridgeForUpgradePath(pathname: string): DeviceBridge | undefined {
      return upgradeBridgeByPath.get(pathname);
    },
    /** Aggregated Pi tools across integrations. */
    piTools(): ToolDefinition[] {
      return tools;
    },
    /** Packaged skills dirs across integrations. */
    skillsDirs(): string[] {
      return skillsDirs;
    },
    /** Wire each integration's events onto the SSE broadcast. Call once. */
    initEvents(broadcast: (event: string, payload: unknown) => void): void {
      for (const { events, ctx } of eventHooks) events(broadcast, ctx);
    },
  };
}

type IntegrationRegistry = ReturnType<typeof createIntegrationRegistry>;

export { canonicalRoutePath, createIntegrationRegistry };
export type { IntegrationRegistry, NodeIntegration };
