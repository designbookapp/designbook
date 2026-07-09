/**
 * The public integration-plugin seam (`@designbookapp/designbook/integration`).
 *
 * STATUS: EXPERIMENTAL. Shapes may change before 1.0.
 *
 * An **integration** connects designbook to an external design/dev tool (the
 * built-in one is Figma). One integration, one `name`, two halves:
 *
 *   - `node` — server half: same-origin-gated REST routes under
 *     `/api/x/<name>/…`, an optional core-owned device bridge (WebSocket at
 *     `/api/bridge/<name>`), Pi agent tools, a packaged skills dir, and event
 *     forwarding onto the workbench SSE stream.
 *   - `ui`   — browser half (lazy): a left-rail tab screen plus an optional
 *     canvas serializer hook.
 *
 * Because the two halves live in different bundles (the node program vs the
 * Vite-built workbench UI), a plugin declares each half in its own entry
 * module under the same `name`; core merges them by name. This file is
 * deliberately compilable by BOTH programs: every node/react import below is
 * type-only.
 *
 * Naming: the concept is "integration" (config key `integrations:`) because
 * `designbookPlugin()` is already the Vite plugin.
 *
 * See docs/specs/figma-integration-plugin.md for the full design.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ComponentType } from "react";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  SelectionContextContribution,
  SelectionContextContributor,
  SelectionContextFact,
  SelectionContextRunCtx,
  SelectionContextSelection,
} from "../config/selectionContext.ts";

// ---------------------------------------------------------------------------
// Device bridge (core-owned; see src/node/bridge/deviceBridge.ts)
// ---------------------------------------------------------------------------

/** The tool-side `hello` a connected device/plugin reported. */
type DeviceHelloInfo = {
  protocol: number;
  fileKey?: string;
  fileName?: string;
  page?: string;
  user?: string;
};

/**
 * A core-owned WebSocket relay to an external tool that cannot listen on a
 * socket itself (a Figma plugin, a device preview app, …): the tool connects
 * OUTBOUND to `/api/bridge/<name>` and executes commands on the plugin's
 * behalf. Structural subset of the concrete bridge in
 * `src/node/bridge/deviceBridge.ts`.
 */
interface DeviceBridge {
  invoke(tool: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  isConnected(): boolean;
  getInfo(): DeviceHelloInfo | undefined;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
  onEvent(cb: (name: string, data: unknown) => void): () => void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

// ---------------------------------------------------------------------------
// Node half
// ---------------------------------------------------------------------------

/** Context handed to an integration's route handlers, pi tools, and events. */
type IntegrationRouteCtx = {
  /** The integration's device bridge, when its node spec requested one. */
  bridge?: DeviceBridge;
  /** Logs a line under the designbook server prefix. */
  log: (message: string) => void;
};

type IntegrationRouteMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * One REST route. Served same-origin-gated (like every designbook `/api/*`
 * route — integrations cannot declare cross-origin exemptions) at the
 * canonical `/api/x/<name>/<path>`, plus any legacy `aliases`.
 */
type PluginRoute = {
  method: IntegrationRouteMethod;
  /** Path segment under `/api/x/<name>/`, e.g. `"status"`. */
  path: string;
  /** Absolute legacy paths served by the same handler, e.g. `"/api/figma/status"`. */
  aliases?: string[];
  /**
   * Marks a route that writes (repo files or other durable state). Write
   * routes are 403'd mechanically when the server runs `--read-only`
   * (canonical and alias paths alike).
   */
  write?: boolean;
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    ctx: IntegrationRouteCtx,
  ) => void | Promise<void>;
};

/** The server half of an integration. */
type PluginNodeSpec = {
  routes?: PluginRoute[];
  /**
   * Request a core device bridge. Core creates it, accepts WS upgrades ONLY at
   * `/api/bridge/<name>` (plus `upgradeAliases`), and passes it to routes /
   * piTools / events as `ctx.bridge`.
   */
  bridge?: {
    /** Wire-protocol version the connected tool must speak. */
    protocol: number;
    /** Legacy upgrade paths kept as aliases, e.g. `"/api/figma-bridge"`. */
    upgradeAliases?: string[];
  };
  /** Pi agent tools contributed to the embedded coding-agent session. */
  piTools?: (ctx: IntegrationRouteCtx) => ToolDefinition[];
  /**
   * Absolute path to a packaged Agent Skills directory, loaded into the Pi
   * session trust-independently (package asset, not repo content).
   */
  skillsDir?: string;
  /**
   * Wire tool events onto the workbench SSE stream. Called once at server
   * startup; `broadcast(event, payload)` fans out to connected workbenches.
   */
  events?: (
    broadcast: (event: string, payload: unknown) => void,
    ctx: IntegrationRouteCtx,
  ) => void;
};

// ---------------------------------------------------------------------------
// UI half
// ---------------------------------------------------------------------------

/**
 * A neutral theme-token source published by an adapter (e.g. the theme
 * adapter) into the workbench registry. Integrations consume it — the figma
 * plugin maps tokens to Figma variables with its own naming options.
 */
type TokenSourceToken = {
  /** Token name (the adapter's own naming, e.g. the CSS var without `--`). */
  name: string;
  type: "color" | "dimension" | "number" | "string";
  /** Resolved value per mode, for the currently-active variant. */
  valuesByMode: Record<string, string>;
  /** CSS custom property (without `--`) to probe live in the preview, if any. */
  cssVar?: string;
  /**
   * Raw CSS expression to probe INSTEAD of `var(--cssVar)` when the custom
   * property may not exist in the document (derived tokens).
   */
  cssValue?: string;
};

type TokenSource = {
  /** Stable id (the publishing adapter's name). */
  id: string;
  /** Suggested collection/display name, e.g. "designbook/theme". */
  collectionHint?: string;
  modes: string[];
  /** Current resolved tokens (active variant). Re-read after `subscribe` fires. */
  getTokens(): TokenSourceToken[];
  /** Write one token value back through the adapter (sync-from flows). */
  setToken?(mode: string, name: string, value: string): Promise<void>;
  /** Opaque passthrough (used by the `theme.figma` deprecation shim). */
  meta?: Record<string, unknown>;
};

/** The open canvas component an integration tab targets. */
type IntegrationEntryRef = {
  id: string;
  label: string;
  sourcePath?: string;
};

/** Props handed to an integration tab's Screen by the workbench. */
type PluginScreenProps = {
  /** The open canvas component, when one is on canvas. */
  entry?: IntegrationEntryRef;
  /** Resolve an `/api/*` path against the designbook server origin. */
  apiUrl: (path: string) => string;
  /**
   * Draft a prompt into the chat tab (revealing it) WITHOUT sending — the
   * user's send click is the confirm gate. No prompt just reveals the tab.
   */
  openChat: (prompt?: string) => void;
  /** Live neutral theme-token sources (see {@link TokenSource}). */
  tokenSources: TokenSource[];
};

type PluginTabSpec = {
  label: string;
  /** Icon component (e.g. a lucide icon). Defaults to a generic icon. */
  icon?: ComponentType;
  Screen: ComponentType<PluginScreenProps>;
};

type SerializeEntryOptions = {
  componentId: string;
  componentName: string;
  meta?: Record<string, unknown>;
};

/** The browser half of an integration (loaded lazily via `ui()`). */
type PluginUiSpec = {
  /** A left-rail tab rendered by the workbench. */
  tab?: PluginTabSpec;
  /**
   * Canvas hook: serialize a rendered entry's DOM subtree into the
   * integration's transfer format. `rootEl` is the preview root `Element`
   * (typed `unknown` so this seam stays compilable without DOM libs).
   */
  serializeEntry?: (
    rootEl: unknown,
    options: SerializeEntryOptions,
  ) => Promise<{ tree: unknown; warnings: string[] }>;
  /**
   * PREVIEW: contribute a section of selection context (Info panel + chat
   * prompt) for the current canvas selection. Registered under the
   * integration's name after the core contributors — see
   * docs/specs/selection-context.md.
   */
  selectionContext?: SelectionContextContributor;
};

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * An integration plugin. In-package builtins (and, later, external packages)
 * declare the two halves in separate entry modules under the same `name`;
 * this combined shape is the conceptual contract core merges by name.
 */
type IntegrationPlugin = {
  name: string;
  ui?: () => Promise<PluginUiSpec>;
  node?: PluginNodeSpec;
};

/**
 * Per-integration value under the config's `integrations:` key: `false`
 * disables a built-in; an object passes integration-specific options.
 */
type IntegrationConfigValue = boolean | Record<string, unknown>;

/** Identity helper for typed node-half declarations. */
function defineIntegrationNode(spec: PluginNodeSpec): PluginNodeSpec {
  return spec;
}

/** Identity helper for typed ui-half declarations. */
function defineIntegrationUi(spec: PluginUiSpec): PluginUiSpec {
  return spec;
}

export { defineIntegrationNode, defineIntegrationUi };
export type {
  DeviceBridge,
  DeviceHelloInfo,
  IntegrationConfigValue,
  IntegrationEntryRef,
  IntegrationPlugin,
  IntegrationRouteCtx,
  IntegrationRouteMethod,
  PluginNodeSpec,
  PluginRoute,
  PluginScreenProps,
  PluginTabSpec,
  PluginUiSpec,
  SelectionContextContribution,
  SelectionContextContributor,
  SelectionContextFact,
  SelectionContextRunCtx,
  SelectionContextSelection,
  SerializeEntryOptions,
  TokenSource,
  TokenSourceToken,
};
