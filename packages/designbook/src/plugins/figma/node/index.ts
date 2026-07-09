/**
 * The figma integration's node half (S4): REST routes, the device bridge
 * request, Pi tools, the packaged figma-pull skill, and SSE event forwarding —
 * everything the server previously hardcoded, declared through the public
 * `PluginNodeSpec` seam and registered by src/node/integrations/builtins.ts.
 *
 * Routes are served canonically at `/api/x/figma/…` with the shipped
 * `/api/figma/…` paths kept as aliases; the bridge upgrades at
 * `/api/bridge/figma` with `/api/figma-bridge` as its alias. Everything talks
 * to Figma through `ctx.bridge` (the core device bridge) — a Figma plugin's
 * UI iframe connects outbound to us and executes `figma.*` calls on our
 * behalf (see src/node/bridge/deviceBridge.ts for the wire protocol).
 */

import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  DeviceBridge,
  IntegrationRouteCtx,
  PluginNodeSpec,
} from "../../../integration/index.ts";
import { readJsonBody, sendJson } from "../../../node/integration/http.ts";
import { formatPullPrompt } from "../shared/figmaPullPrompt.ts";
import type { PullRenderContext } from "../shared/figmaRender.ts";

/** The bridge, non-optional: this spec always requests one. */
function bridgeOf(ctx: IntegrationRouteCtx): DeviceBridge {
  if (!ctx.bridge) throw new Error("figma integration: bridge missing.");
  return ctx.bridge;
}

type FigmaNodeSummary = {
  id: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  fills?: unknown;
  characters?: string;
};

function summarizeFigmaNodes(nodes: FigmaNodeSummary[]): string {
  if (nodes.length === 0) return "No nodes selected in Figma.";
  const lines = nodes.map((node) => {
    const size =
      node.width !== undefined && node.height !== undefined
        ? ` ${Math.round(node.width)}x${Math.round(node.height)}`
        : "";
    const text = node.characters ? ` "${node.characters}"` : "";
    return `- ${node.name} (${node.type}, id: ${node.id})${size}${text}`;
  });
  return `Selected ${nodes.length} node(s) in Figma:\n${lines.join("\n")}`;
}

/** Serialized component pushes carry inline images — allow up to 25MB. */
const FIGMA_PUSH_MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Error with the HTTP status the REST pull handler should answer with. */
type PullError = Error & { status: number };

function pullError(status: number, message: string): PullError {
  const error = new Error(message) as PullError;
  error.status = status;
  return error;
}

/**
 * Pull flow shared by `POST /api/x/figma/pull` and the Pi
 * `figma_pull_component` tool: read the selected component back out of Figma
 * as the annotated HTML target (see figma-plugin/readHtml.ts). Declarative —
 * no baseline, no diff, no cursor. Throws `PullError` (409 disconnected, 404
 * no pushed frame).
 */
async function pullComponentHtml(
  ctx: IntegrationRouteCtx,
  componentId: string,
): Promise<{ componentId: string; html: string; render?: PullRenderContext }> {
  const bridge = bridgeOf(ctx);
  if (!bridge.isConnected()) {
    throw pullError(
      409,
      "No Figma plugin connected. Open the designbook plugin in Figma.",
    );
  }

  let result: { html: string; render?: PullRenderContext };
  try {
    result = (await bridge.invoke(
      "figma_read_html",
      { componentId },
      60_000,
    )) as { html: string; render?: PullRenderContext };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The bridge only relays error messages; the plugin prefixes its
    // missing-root error with this marker (see figma-plugin/readHtml.ts).
    if (message.includes("[not-found]")) {
      throw pullError(404, message.replace("[not-found] ", ""));
    }
    throw error;
  }

  ctx.log(`pull: ${componentId} -> ${result.html.length} html char(s)`);
  return { componentId, html: result.html, render: result.render };
}

// --- REST handlers (browser Sync UI proxies over the plugin bridge) --------
//
// The browser does all token↔variable mapping (see the plugin's ui half);
// these endpoints are thin structural proxies. When no plugin is connected
// they answer 409 so the UI can gray out the buttons / show a clear message
// instead of a generic 500.

function handleStatus(response: ServerResponse, ctx: IntegrationRouteCtx) {
  const bridge = bridgeOf(ctx);
  sendJson(response, 200, {
    connected: bridge.isConnected(),
    info: bridge.getInfo() ?? null,
  });
}

async function handleGetVariables(
  response: ServerResponse,
  ctx: IntegrationRouteCtx,
) {
  const bridge = bridgeOf(ctx);
  if (!bridge.isConnected()) {
    sendJson(response, 409, { error: "no plugin" });
    return;
  }
  const result = await bridge.invoke("figma_get_variables", {});
  sendJson(response, 200, result);
}

async function handleSetVariables(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: IntegrationRouteCtx,
) {
  const bridge = bridgeOf(ctx);
  if (!bridge.isConnected()) {
    sendJson(response, 409, { error: "no plugin" });
    return;
  }
  const body = await readJsonBody<{
    name?: unknown;
    modes?: unknown;
    variables?: unknown;
  }>(request);
  const result = await bridge.invoke("figma_set_variables", {
    collection: body.name,
    modes: body.modes,
    variables: body.variables,
  });
  sendJson(response, 200, result);
}

async function handlePull(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: IntegrationRouteCtx,
) {
  const body = await readJsonBody<{ componentId?: unknown }>(request);
  const componentId =
    typeof body.componentId === "string" ? body.componentId.trim() : "";
  if (!componentId) {
    sendJson(response, 400, { error: "componentId is required." });
    return;
  }

  try {
    sendJson(response, 200, await pullComponentHtml(ctx, componentId));
  } catch (error) {
    const status = (error as Partial<PullError>).status;
    if (typeof status === "number") {
      sendJson(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    throw error;
  }
}

async function handlePush(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: IntegrationRouteCtx,
) {
  const bridge = bridgeOf(ctx);
  if (!bridge.isConnected()) {
    sendJson(response, 409, { error: "no plugin" });
    return;
  }

  const body = await readJsonBody<{ tree?: unknown }>(
    request,
    FIGMA_PUSH_MAX_BODY_BYTES,
  );
  const tree = body.tree as { componentId?: unknown } | undefined;
  if (!tree || typeof tree.componentId !== "string" || !tree.componentId) {
    sendJson(response, 400, {
      error: "A serialized render tree (with componentId) is required.",
    });
    return;
  }

  const result = (await bridge.invoke(
    "figma_render_nodes",
    { tree },
    60_000,
  )) as { nodeId?: string; warnings?: string[] };

  ctx.log(`push: ${tree.componentId} -> ${result?.nodeId ?? "unknown"}`);
  sendJson(response, 200, result);
}

/**
 * Exports a pushed component's Figma root frame as a PNG for the fidelity
 * harness (docs/specs/figma-sync-testing.md). Relays the plugin's
 * `{ base64, width, height }` JSON verbatim (the runner decodes). 120s
 * timeout — export is the plugin API's slow path. 409 disconnected, 404 no
 * pushed frame, same convention as pull.
 */
async function handleExport(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: IntegrationRouteCtx,
) {
  const bridge = bridgeOf(ctx);
  if (!bridge.isConnected()) {
    sendJson(response, 409, { error: "no plugin" });
    return;
  }
  const body = await readJsonBody<{ componentId?: unknown; scale?: unknown }>(
    request,
  );
  const componentId =
    typeof body.componentId === "string" ? body.componentId.trim() : "";
  if (!componentId) {
    sendJson(response, 400, { error: "componentId is required." });
    return;
  }
  const scale = typeof body.scale === "number" ? body.scale : undefined;
  try {
    const result = await bridge.invoke(
      "figma_export_png",
      { componentId, scale },
      120_000,
    );
    ctx.log(`export: ${componentId}`);
    sendJson(response, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("[not-found]")) {
      sendJson(response, 404, { error: message.replace("[not-found] ", "") });
      return;
    }
    throw error;
  }
}

/** Debug: raw annotated HTML for a pushed component (same read as pull). */
async function handleHtml(
  url: URL,
  response: ServerResponse,
  ctx: IntegrationRouteCtx,
) {
  const bridge = bridgeOf(ctx);
  if (!bridge.isConnected()) {
    sendJson(response, 409, { error: "no plugin" });
    return;
  }
  const componentId = (url.searchParams.get("componentId") ?? "").trim();
  if (!componentId) {
    sendJson(response, 400, { error: "componentId is required." });
    return;
  }
  try {
    sendJson(response, 200, await pullComponentHtml(ctx, componentId));
  } catch (error) {
    const status = (error as Partial<PullError>).status;
    if (typeof status === "number") {
      sendJson(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    throw error;
  }
}

// --- Pi tools ---------------------------------------------------------------
//
// Tool registration while no plugin is connected: the Pi SDK only accepts
// `customTools` at `createAgentSession()` time — there is no
// `registerTool`/`unregisterTool` on a live `AgentSession`. So instead of a
// disruptive session reset every time a plugin connects/disconnects, the
// Figma tools are registered statically and always active; each `execute`
// just throws a clear, LLM-facing error when the bridge is disconnected (the
// SDK catches thrown tool errors, marks the result `isError: true`, and keeps
// the session alive). `figma_status` lets Pi (and the designer) check
// connection state without a round trip.

function buildPiTools(ctx: IntegrationRouteCtx): ToolDefinition[] {
  const bridge = bridgeOf(ctx);
  return [
    defineTool({
      name: "figma_get_selection",
      label: "Get Figma Selection",
      description:
        "Reads the current selection in the connected Figma file (requires the designbook Figma plugin to be running and connected).",
      parameters: Type.Object({}),
      execute: async () => {
        const nodes = (await bridge.invoke(
          "figma_get_selection",
          {},
        )) as FigmaNodeSummary[];
        return {
          content: [{ type: "text" as const, text: summarizeFigmaNodes(nodes) }],
          details: { nodes },
        };
      },
    }),
    defineTool({
      name: "figma_create_frame",
      label: "Create Figma Frame",
      description:
        "Creates a new frame on the current page of the connected Figma file (requires the designbook Figma plugin to be running and connected).",
      parameters: Type.Object({
        name: Type.String({ description: "Name for the new frame." }),
        width: Type.Number({ description: "Frame width in px." }),
        height: Type.Number({ description: "Frame height in px." }),
        fills: Type.Optional(
          Type.Array(
            Type.Object({
              type: Type.String({ description: 'Paint type, e.g. "SOLID".' }),
              color: Type.Optional(
                Type.Object({
                  r: Type.Number(),
                  g: Type.Number(),
                  b: Type.Number(),
                }),
              ),
              opacity: Type.Optional(Type.Number()),
            }),
            { description: "Fills to apply to the frame." },
          ),
        ),
        text: Type.Optional(
          Type.String({
            description: "Optional text content added as a child text node.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const result = (await bridge.invoke("figma_create_frame", params)) as {
          nodeId: string;
          url: string;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Created frame "${params.name}" in Figma: ${result.url}`,
            },
          ],
          details: result,
        };
      },
    }),
    defineTool({
      name: "figma_get_variables",
      label: "Get Figma Variables",
      description:
        "Reads every local variable collection (modes + variables with their per-mode values) from the connected Figma file (requires the designbook Figma plugin to be running and connected). Structural — no token mapping is applied.",
      parameters: Type.Object({}),
      execute: async () => {
        const result = (await bridge.invoke(
          "figma_get_variables",
          {},
        )) as { collections?: unknown[] };
        const count = Array.isArray(result.collections)
          ? result.collections.length
          : 0;
        return {
          content: [
            {
              type: "text" as const,
              text: `Read ${count} local variable collection(s) from Figma.`,
            },
          ],
          details: result,
        };
      },
    }),
    defineTool({
      name: "figma_set_variables",
      label: "Set Figma Variables",
      description:
        "Creates or updates a local variable collection and its variables in the connected Figma file (requires the designbook Figma plugin to be running and connected). Structural — values are passed through verbatim (COLOR as {r,g,b,a}).",
      parameters: Type.Object({
        collection: Type.String({ description: "Collection name to find or create." }),
        modes: Type.Array(Type.String(), {
          description: "Mode names to ensure exist on the collection.",
        }),
        variables: Type.Array(
          Type.Object({
            name: Type.String(),
            type: Type.Union([
              Type.Literal("COLOR"),
              Type.Literal("FLOAT"),
              Type.Literal("STRING"),
            ]),
            valuesByMode: Type.Record(Type.String(), Type.Any()),
          }),
          { description: "Variables to create/update, with per-mode values." },
        ),
      }),
      execute: async (_toolCallId, params) => {
        const result = (await bridge.invoke(
          "figma_set_variables",
          params,
        )) as { collectionId: string; created: number; updated: number };
        return {
          content: [
            {
              type: "text" as const,
              text: `Synced Figma collection "${params.collection}": ${result.created} created, ${result.updated} updated.`,
            },
          ],
          details: result,
        };
      },
    }),
    defineTool({
      name: "figma_pull_component",
      label: "Pull Figma Component",
      description:
        "Reads a designbook component out of the connected Figma file as an annotated HTML target (the declarative render the designer authored), and returns a prompt asking you to rewrite the component so it renders that output. Handles both edits and brand-new components. Follow the figma-pull skill for the annotation format (data-slot/data-i18n/data-token-*/data-component/data-list) and reconciliation rules. Requires the designbook Figma plugin running and a prior push of the component. Read the component's source before editing.",
      parameters: Type.Object({
        componentId: Type.String({
          description:
            'designbook registry id of the component, e.g. "product.ProductCard".',
        }),
      }),
      execute: async (_toolCallId, params) => {
        const { html, render } = await pullComponentHtml(
          ctx,
          params.componentId,
        );
        const text = formatPullPrompt({
          componentId: params.componentId,
          html,
          render,
        });
        return {
          content: [{ type: "text" as const, text }],
          details: { componentId: params.componentId, html, render },
        };
      },
    }),
    defineTool({
      name: "figma_status",
      label: "Figma Connection Status",
      description:
        "Reports whether the designbook Figma plugin is currently connected, and which file/page it's connected to. Does not require a connection.",
      parameters: Type.Object({}),
      execute: async () => {
        const connected = bridge.isConnected();
        const info = bridge.getInfo();
        const text = connected
          ? `Figma plugin connected (file: ${info?.fileName ?? "unknown"}, page: ${info?.page ?? "unknown"}).`
          : "No Figma plugin connected. Open the designbook plugin in Figma to connect.";
        return {
          content: [{ type: "text" as const, text }],
          details: { connected, info },
        };
      },
    }),
  ];
}

/**
 * Absolute path to the plugin's packaged skills dir. Resolves next to this
 * module, which works from source (src/plugins/figma/skills) and from a build
 * (dist/plugins/figma/skills — copied by scripts/copy-skills.mjs).
 */
function figmaSkillsDir(): string | undefined {
  const dir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../skills",
  );
  return existsSync(dir) ? dir : undefined;
}

/** The figma integration's node spec (registered by builtins.ts). */
function figmaNode(): PluginNodeSpec {
  return {
    bridge: { protocol: 1, upgradeAliases: ["/api/figma-bridge"] },
    routes: [
      {
        method: "GET",
        path: "status",
        aliases: ["/api/figma/status"],
        handler: (_request, response, _url, ctx) =>
          handleStatus(response, ctx),
      },
      {
        method: "POST",
        path: "push",
        aliases: ["/api/figma/push"],
        handler: (request, response, _url, ctx) =>
          handlePush(request, response, ctx),
      },
      {
        method: "POST",
        path: "pull",
        aliases: ["/api/figma/pull"],
        handler: (request, response, _url, ctx) =>
          handlePull(request, response, ctx),
      },
      {
        method: "GET",
        path: "html",
        aliases: ["/api/figma/html"],
        handler: (_request, response, url, ctx) =>
          handleHtml(url, response, ctx),
      },
      {
        method: "POST",
        path: "export",
        aliases: ["/api/figma/export"],
        handler: (request, response, _url, ctx) =>
          handleExport(request, response, ctx),
      },
      {
        method: "POST",
        path: "variables",
        aliases: ["/api/figma/variables"],
        handler: (_request, response, _url, ctx) =>
          handleGetVariables(response, ctx),
      },
      {
        method: "PUT",
        path: "variables",
        aliases: ["/api/figma/variables"],
        handler: (request, response, _url, ctx) =>
          handleSetVariables(request, response, ctx),
      },
      {
        // GET is the disconnected-probe path the E2E gate exercises; behaves
        // like POST (read variables) but is safe to call without a body.
        method: "GET",
        path: "variables",
        aliases: ["/api/figma/variables"],
        handler: (_request, response, _url, ctx) =>
          handleGetVariables(response, ctx),
      },
    ],
    piTools: buildPiTools,
    skillsDir: figmaSkillsDir(),
    events: (broadcast, ctx) => {
      ctx.bridge?.onEvent((name, data) => {
        broadcast("figma-event", { name, data });
      });
      ctx.bridge?.onConnectionChange((connected) => {
        ctx.log(`plugin ${connected ? "connected" : "disconnected"}`);
      });
    },
  };
}

export { figmaNode, figmaSkillsDir };
