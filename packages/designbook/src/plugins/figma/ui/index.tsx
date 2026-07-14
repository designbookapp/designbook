/**
 * The figma integration's ui half: lazy tab (FigmaPanel) + the canvas
 * serializeEntry hook (the push serializer). Registered by
 * src/ui/integrations/builtins.ts. The dynamic imports keep the whole figma
 * UI graph in its own lazily-reached chunk AND break the module cycle
 * (integrations registry → builtins → here → FigmaPanel → integrations).
 */

import { FigmaIcon } from "lucide-react";
import type {
  PluginUiSpec,
  SelectionContextContribution,
  SelectionContextRunCtx,
  SerializeEntryOptions,
} from "@designbook-ui/integrations";

/**
 * Selection-context contribution (PREVIEW): connection status + whether
 * push/pull is available for the selected component. Kept tiny on purpose —
 * it dogfoods the `PluginUiSpec.selectionContext` seam third parties get.
 */
async function figmaSelectionContext(
  ctx: SelectionContextRunCtx,
): Promise<SelectionContextContribution | undefined> {
  try {
    const response = await fetch(ctx.apiUrl("/api/x/figma/status"));
    if (!response.ok) return undefined;
    const payload = (await response.json()) as {
      connected?: boolean;
      info?: { fileName?: string; page?: string } | null;
    };
    const connected = Boolean(payload.connected);
    return {
      source: "figma",
      title: "Figma",
      facts: [
        {
          label: "Plugin",
          value: connected
            ? `Connected${payload.info?.fileName ? ` — ${payload.info.fileName}` : ""}`
            : "Not connected",
        },
        {
          label: "Sync",
          value: connected
            ? "Push/pull available for this component"
            : "Open the designbook plugin in Figma to enable push/pull",
        },
      ],
      prompt: connected
        ? "Figma plugin connected; push/pull is available for this component."
        : undefined,
    };
  } catch {
    return undefined;
  }
}

async function figmaUi(): Promise<PluginUiSpec> {
  const [{ FigmaPanel }, { FigmaSection }, { serializeComponent }] =
    await Promise.all([
      import("./FigmaPanel"),
      import("./FigmaSection"),
      import("./serialize"),
    ]);
  return {
    tab: {
      label: "Figma",
      icon: FigmaIcon,
      Screen: FigmaPanel,
    },
    serializeEntry: (rootEl: unknown, options: SerializeEntryOptions) =>
      serializeComponent(rootEl as Element, {
        componentId: options.componentId,
        componentName: options.componentName,
        meta: options.meta as Parameters<
          typeof serializeComponent
        >[1]["meta"],
      }),
    selectionContext: (_sel, ctx) => figmaSelectionContext(ctx),
    // The figma HOME in the full view: push/pull/status for the SELECTED
    // component, appended below the core prop controls (the retired left-rail
    // tab's replacement). Registered under `figma:` by the section registry.
    propsSections: [
      {
        id: "sync",
        title: "Figma",
        order: 10,
        Component: FigmaSection,
      },
    ],
  };
}

export { figmaUi };
