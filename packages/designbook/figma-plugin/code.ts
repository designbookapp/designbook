/**
 * designbook Figma plugin — main thread.
 *
 * Figma's main thread has `figma.*` but no network/WebSocket access. The UI
 * iframe (ui.ts) owns the WebSocket connection to designbook; this file just
 * executes `figma.*` calls on request and reports results back to the UI via
 * `figma.ui.postMessage` / `figma.ui.onmessage`.
 *
 * Message shapes exchanged with the UI (all wrapped in Figma's
 * `{ pluginMessage: ... }` envelope, which the typings/runtime handle):
 *   main -> ui: { type: "init", fileKey, fileName, page, user }
 *   main -> ui: { type: "event", name, data }
 *   ui -> main: { type: "execute", requestId, tool, params }
 *   main -> ui: { type: "executeResult", requestId, ok, data?, error? }
 */

import { renderNodes, type RenderNodesParams } from "./render.ts";
import { readHtml, type ReadHtmlParams } from "./readHtml.ts";

figma.showUI(__html__, { width: 320, height: 140 });

type NodeSummary = {
  id: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  fills?: unknown;
  characters?: string;
};

function summarizeSelection(): NodeSummary[] {
  return figma.currentPage.selection.map((node) => {
    const summary: NodeSummary = {
      id: node.id,
      name: node.name,
      type: node.type,
    };
    if ("width" in node) summary.width = node.width;
    if ("height" in node) summary.height = node.height;
    if ("fills" in node && Array.isArray(node.fills)) {
      summary.fills = node.fills;
    }
    if (node.type === "TEXT") {
      summary.characters = node.characters;
    }
    return summary;
  });
}

function postInit() {
  figma.ui.postMessage({
    type: "init",
    fileKey: figma.fileKey,
    fileName: figma.root.name,
    page: figma.currentPage.name,
    user: figma.currentUser?.name,
  });
}

postInit();

figma.on("selectionchange", () => {
  figma.ui.postMessage({
    type: "event",
    name: "selectionchange",
    data: summarizeSelection(),
  });
});

type FillInput = {
  type?: string;
  color?: { r: number; g: number; b: number };
  opacity?: number;
};

type CreateFrameParams = {
  name: string;
  width: number;
  height: number;
  fills?: FillInput[];
  text?: string;
};

async function createFrame(params: CreateFrameParams) {
  const frame = figma.createFrame();
  frame.name = params.name;
  frame.resize(Math.max(1, params.width), Math.max(1, params.height));

  if (params.fills && params.fills.length > 0) {
    frame.fills = params.fills.map((fill) => ({
      type: (fill.type as SolidPaint["type"]) ?? "SOLID",
      color: fill.color ?? { r: 1, g: 1, b: 1 },
      opacity: fill.opacity,
    })) as Paint[];
  }

  const rectSize = Math.max(8, Math.min(80, Math.min(params.width, params.height) - 16));
  const rect = figma.createRectangle();
  rect.resize(rectSize, rectSize);
  rect.x = 16;
  rect.y = 16;
  frame.appendChild(rect);

  if (params.text) {
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    const textNode = figma.createText();
    textNode.characters = params.text;
    textNode.x = 16;
    textNode.y = rect.y + rectSize + 16;
    frame.appendChild(textNode);
  }

  figma.currentPage.appendChild(frame);
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);

  return {
    nodeId: frame.id,
    url: `https://figma.com/file/${figma.fileKey}?node-id=${encodeURIComponent(frame.id)}`,
  };
}

// --- Variables (theme token sync) ---------------------------------------

type FigmaVarType = "COLOR" | "FLOAT" | "STRING";
type Rgba = { r: number; g: number; b: number; a: number };
type FigmaVarValue = Rgba | number | string;

type GetVariablesResult = {
  collections: Array<{
    name: string;
    modes: string[];
    variables: Array<{
      name: string;
      resolvedType: FigmaVarType;
      valuesByMode: Record<string, FigmaVarValue>;
    }>;
  }>;
};

/** Reads every local variable collection into the structural sync shape. */
async function getVariables(): Promise<GetVariablesResult> {
  const collections =
    await figma.variables.getLocalVariableCollectionsAsync();
  const out: GetVariablesResult["collections"] = [];

  for (const collection of collections) {
    const modeIdToName = new Map<string, string>();
    for (const mode of collection.modes) {
      modeIdToName.set(mode.modeId, mode.name);
    }

    const variables: GetVariablesResult["collections"][number]["variables"] =
      [];
    for (const id of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(id);
      if (!variable) continue;
      const valuesByMode: Record<string, FigmaVarValue> = {};
      for (const [modeId, value] of Object.entries(variable.valuesByMode)) {
        const modeName = modeIdToName.get(modeId);
        if (modeName === undefined) continue;
        valuesByMode[modeName] = value as FigmaVarValue;
      }
      variables.push({
        name: variable.name,
        resolvedType: variable.resolvedType as FigmaVarType,
        valuesByMode,
      });
    }

    out.push({
      name: collection.name,
      modes: collection.modes.map((mode) => mode.name),
      variables,
    });
  }

  return { collections: out };
}

type SetVariablesParams = {
  collection: string;
  modes: string[];
  variables: Array<{
    name: string;
    type: FigmaVarType;
    valuesByMode: Record<string, FigmaVarValue>;
  }>;
};

/**
 * Find-or-create a collection by name, ensuring the requested modes exist.
 * Figma limits variable collections to a single mode on non-enterprise plans,
 * so `addMode` can throw ("Limited to 1 modes only"). We apply as many modes as
 * the plan allows (the first requested mode always succeeds — it renames the
 * default mode) and report the rest as skipped so the push still succeeds with
 * the first mode's values.
 */
async function ensureCollection(
  name: string,
  modes: string[],
): Promise<{
  collection: VariableCollection;
  applied: string[];
  skipped: string[];
}> {
  const existing =
    await figma.variables.getLocalVariableCollectionsAsync();
  let collection = existing.find((candidate) => candidate.name === name);
  if (!collection) {
    collection = figma.variables.createVariableCollection(name);
  }

  const wanted = modes.length > 0 ? modes : ["Mode 1"];
  const applied: string[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < wanted.length; i++) {
    const modeName = wanted[i];
    if (collection.modes.some((mode) => mode.name === modeName)) {
      applied.push(modeName);
      continue;
    }
    if (i === 0 && collection.modes.length === 1) {
      collection.renameMode(collection.modes[0].modeId, modeName);
      applied.push(modeName);
      continue;
    }
    try {
      collection.addMode(modeName);
      applied.push(modeName);
    } catch {
      // Plan mode limit reached — skip the remaining modes.
      skipped.push(modeName);
    }
  }
  return { collection, applied, skipped };
}

async function setVariables(params: SetVariablesParams) {
  const { collection, skipped: skippedModes } = await ensureCollection(
    params.collection,
    params.modes,
  );
  const modeNameToId = new Map<string, string>();
  for (const mode of collection.modes) modeNameToId.set(mode.name, mode.modeId);

  // Index existing variables in this collection by name for reuse.
  const existingByName = new Map<string, Variable>();
  for (const id of collection.variableIds) {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable) existingByName.set(variable.name, variable);
  }

  let created = 0;
  let updated = 0;

  for (const spec of params.variables) {
    let variable = existingByName.get(spec.name);
    if (variable && variable.resolvedType !== spec.type) {
      // Type changed — recreate under the same name.
      variable.remove();
      variable = undefined;
    }
    if (!variable) {
      variable = figma.variables.createVariable(
        spec.name,
        collection,
        spec.type,
      );
      existingByName.set(spec.name, variable);
      created++;
    } else {
      updated++;
    }

    for (const [modeName, value] of Object.entries(spec.valuesByMode)) {
      const modeId = modeNameToId.get(modeName);
      if (modeId === undefined) continue;
      variable.setValueForMode(modeId, value as VariableValue);
    }
  }

  return { collectionId: collection.id, created, updated, skippedModes };
}

async function runTool(tool: string, params: unknown): Promise<unknown> {
  switch (tool) {
    case "figma_get_selection":
      return summarizeSelection();
    case "figma_create_frame":
      return createFrame(params as CreateFrameParams);
    case "figma_get_variables":
      return getVariables();
    case "figma_set_variables":
      return setVariables(params as SetVariablesParams);
    case "figma_render_nodes":
      return renderNodes(params as RenderNodesParams);
    case "figma_read_html":
      return readHtml(params as ReadHtmlParams);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

type ExecuteRequest = {
  type: "execute";
  requestId: number;
  tool: string;
  params: unknown;
};

figma.ui.onmessage = async (msg: ExecuteRequest) => {
  if (!msg || msg.type !== "execute") return;

  try {
    const data = await runTool(msg.tool, msg.params);
    figma.ui.postMessage({
      type: "executeResult",
      requestId: msg.requestId,
      ok: true,
      data,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "executeResult",
      requestId: msg.requestId,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
};
