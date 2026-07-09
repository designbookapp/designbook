/**
 * `figma_export_png` — exports a pushed designbook component's root frame as a
 * PNG, for the fidelity harness's browser-render vs real-Figma-render pixel
 * compare (docs/specs/figma-sync-testing.md, tier 2). The root is located the
 * same way readHtml.ts does: sharedPluginData stamp (componentId + kind:"root",
 * written by render.ts).
 *
 * `colorProfile: "SRGB"` pins the color space so the compare against Chromium
 * (sRGB) is apples-to-apples; SCALE defaults to 2 to match the harness's
 * `deviceScaleFactor: 2` browser screenshots. `figma.base64Encode` ships the
 * bytes as a JSON string — the bridge relays JSON only. A defensive base64 size
 * guard fails loudly instead of stalling the socket on a pathological case.
 *
 * Framework-free beyond the Figma plugin API; ES2017-safe.
 */

const NS = "designbook";

/**
 * Base64 grows 4/3× over raw; ~8MB base64 ≈ ~6MB PNG — far above a
 * component-sized 2× frame (spec measured ~70KB–1.4MB). Above this we throw
 * rather than flood the JSON-only WebSocket bridge (figmaBridge.ts).
 */
const MAX_BASE64_BYTES = 8 * 1024 * 1024;

type ExportPngParams = {
  componentId: string;
  scale?: number;
};

type ExportPngResult = {
  componentId: string;
  rootNodeId: string;
  /** PNG bytes, base64-encoded (the runner decodes to a file). */
  base64: string;
  /** Exported pixel dimensions (frame size × scale, rounded). */
  width: number;
  height: number;
  scale: number;
};

/** The pushed root frame for `componentId` on the current page, or undefined. */
function findRoot(componentId: string): SceneNode | undefined {
  const stamped = figma.currentPage.findAllWithCriteria({
    sharedPluginData: { namespace: NS, keys: ["componentId"] },
  });
  return stamped.find(
    (node) =>
      node.getSharedPluginData(NS, "componentId") === componentId &&
      node.getSharedPluginData(NS, "kind") === "root",
  );
}

async function exportPng(params: ExportPngParams): Promise<ExportPngResult> {
  const componentId = params ? params.componentId : undefined;
  if (typeof componentId !== "string" || componentId === "") {
    throw new Error("figma_export_png: params.componentId is required.");
  }
  const scale =
    typeof params.scale === "number" && params.scale > 0 ? params.scale : 2;

  const root = findRoot(componentId);
  if (!root) {
    // "[not-found]" is the machine-readable code the bridge/server sniff for 404
    // (mirrors readHtml.ts).
    throw new Error(
      `[not-found] No pushed designbook root for "${componentId}" on the current page. Push the component to Figma first (or re-push if the frame was deleted).`,
    );
  }
  if (!("exportAsync" in root)) {
    throw new Error(
      `figma_export_png: node for "${componentId}" is not exportable.`,
    );
  }

  const settings: ExportSettingsImage = {
    format: "PNG",
    constraint: { type: "SCALE", value: scale },
    colorProfile: "SRGB",
  };
  const bytes = await (
    root as SceneNode & {
      exportAsync(s: ExportSettingsImage): Promise<Uint8Array>;
    }
  ).exportAsync(settings);

  const base64 = figma.base64Encode(bytes);
  if (base64.length > MAX_BASE64_BYTES) {
    throw new Error(
      `figma_export_png: exported PNG is ${Math.round(base64.length / 1024)}KB base64, over the ${Math.round(MAX_BASE64_BYTES / 1024)}KB bridge guard. Lower --scale or shrink the case.`,
    );
  }

  const width = "width" in root ? Math.round(root.width * scale) : 0;
  const height = "height" in root ? Math.round(root.height * scale) : 0;
  return { componentId, rootNodeId: root.id, base64, width, height, scale };
}

export { exportPng };
export type { ExportPngParams, ExportPngResult };
