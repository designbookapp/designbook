/**
 * "Push to Figma" / "Pull from Figma" actions for the open component, rendered
 * inside the figma integration tab (FigmaPanel). Push serializes the live
 * canvas preview (see previewHost's serializeComponent) and POSTs the
 * resulting `RenderTree` to `/api/x/figma/push`, which relays it to the
 * connected Figma plugin. Pull POSTs to `/api/x/figma/pull` (declarative
 * read-back → annotated HTML) and drafts the Pi handoff prompt straight into
 * the chat tab via the integration seam's `openChat` — nothing is sent; the
 * user's send click in the chat IS the confirm gate. Both buttons are enabled
 * only while a plugin is connected — the connection state is polled by the
 * surrounding FigmaPanel and handed in as a prop.
 *
 * Token attribution (G2a): the figma-name mapping now arrives as props
 * (`pushCollection`/`pushTokens`, computed by FigmaPanel from the neutral
 * TokenSource registry + the figma integration's token options) and is passed
 * explicitly into the serializer — no global figma token source.
 */

import { useState } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  DownloadIcon,
  Loader2Icon,
  SendIcon,
} from "lucide-react";
import { Button } from "@designbook-ui/components/ui/button";
import { cn } from "@designbook-ui/lib/utils";
import {
  getAdapterRuntime,
  type PluginScreenProps,
} from "@designbook-ui/integrations";
import { serializeComponent } from "./serialize";
import { formatPullPrompt } from "../shared/figmaPullPrompt";
import type { PullRenderContext } from "../shared/figmaRender";
import type { AttributionToken } from "./figmaTokenSync";

const copy = {
  push: "Push to Figma",
  pushing: "Pushing…",
  pull: "Pull from Figma",
  pulling: "Pulling…",
  disconnectedTitle: "Open the designbook plugin in Figma to enable pushing.",
  notConnected:
    "No Figma plugin connected — open the designbook plugin in Figma and try again.",
  previewMissing: "Could not find the rendered preview to serialize.",
  pushFailed: "Push to Figma failed.",
  pullFailed: "Pull from Figma failed.",
  neverPushed:
    "This component has no Figma push yet — push it to Figma first.",
  pulledToChat: "Figma target drafted into chat — review and send.",
};

/** Value of the first adapter dimension whose id ends with `:<localId>`. */
function dimensionValue(localId: string): string | undefined {
  const runtime = getAdapterRuntime();
  const dimension = runtime.dimensions.find((candidate) =>
    candidate.id.endsWith(`:${localId}`),
  );
  if (!dimension) return undefined;
  const { context } = runtime.getSnapshot();
  return context[dimension.id] ?? dimension.defaultValue;
}

/**
 * Every OTHER active adapter dimension value (flags etc.) for the render
 * context stamped into the Figma root marker — locale/variant/mode are
 * already first-class in the push meta, so they are excluded here.
 */
function otherDimensionValues(): Record<string, string> | undefined {
  const runtime = getAdapterRuntime();
  const { context } = runtime.getSnapshot();
  const dimensions: Record<string, string> = {};
  for (const dimension of runtime.dimensions) {
    if (/:(locale|variant|mode)$/.test(dimension.id)) continue;
    const value = context[dimension.id] ?? dimension.defaultValue;
    if (value !== undefined) dimensions[dimension.id] = value;
  }
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

type PushResult = {
  nodeId?: string;
  created?: boolean;
  counts?: Record<string, number>;
  warnings?: string[];
};

type PushState =
  | { phase: "idle" }
  | { phase: "pushing" }
  | { phase: "done"; message: string; warnings: string[] }
  | { phase: "error"; message: string };

function summarizeCounts(counts: Record<string, number> | undefined): string {
  if (!counts) return "";
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

type PullResultPayload = {
  componentId: string;
  html: string;
  /** Render context the push stamped into the root marker (may be absent). */
  render?: PullRenderContext;
};

type PullUiState =
  | { phase: "idle" }
  | { phase: "pulling" }
  | { phase: "done" }
  | { phase: "error"; message: string };

function FigmaSyncControls({
  connected,
  apiUrl,
  entryId,
  entryLabel,
  sourcePath,
  openChat,
  pushCollection,
  pushTokens,
}: {
  /** Whether the Figma plugin bridge is connected (polled by FigmaPanel). */
  connected: boolean;
  apiUrl: PluginScreenProps["apiUrl"];
  entryId: string;
  entryLabel: string;
  /** Repo-relative source file of the entry (for the Pi handoff prompt). */
  sourcePath?: string;
  /** Drafts the pull prompt into the chat tab (the user sends it). */
  openChat: PluginScreenProps["openChat"];
  /** Target variable collection stamped into the push meta. */
  pushCollection?: string;
  /** Token attribution rows for the serializer (neutral sources + NameMap). */
  pushTokens: AttributionToken[];
}) {
  const [state, setState] = useState<PushState>({ phase: "idle" });
  const [pullState, setPullState] = useState<PullUiState>({ phase: "idle" });

  async function pull() {
    setPullState({ phase: "pulling" });
    try {
      const response = await fetch(apiUrl("/api/x/figma/pull"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ componentId: entryId }),
      });
      if (response.status === 409) throw new Error(copy.notConnected);
      if (response.status === 404) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? copy.neverPushed);
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? copy.pullFailed);
      }
      const { html, render } = (await response.json()) as PullResultPayload;
      // Draft the prompt straight into the chat input — the user's send click
      // there is the single confirm gate (no second gate here). The current
      // source is NOT inlined: the figma-pull skill has Pi read the file.
      openChat(formatPullPrompt({ componentId: entryId, sourcePath, html, render }));
      setPullState({ phase: "done" });
    } catch (error) {
      setPullState({
        phase: "error",
        message: error instanceof Error ? error.message : copy.pullFailed,
      });
    }
  }

  async function push() {
    setState({ phase: "pushing" });
    try {
      const rootEl = document.querySelector(
        `[data-db-entry="${CSS.escape(entryId)}"]`,
      );
      if (!rootEl) throw new Error(copy.previewMissing);

      const { tree, warnings } = await serializeComponent(rootEl, {
        componentId: entryId,
        componentName: entryLabel,
        meta: {
          locale: dimensionValue("locale") ?? "en-US",
          variant: dimensionValue("variant") ?? "default",
          mode: dimensionValue("mode") ?? "light",
          collection: pushTokens.length > 0 ? pushCollection : undefined,
          dimensions: otherDimensionValues(),
        },
        tokens: pushTokens,
      });

      const response = await fetch(apiUrl("/api/x/figma/push"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tree }),
      });
      if (response.status === 409) throw new Error(copy.notConnected);
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? copy.pushFailed);
      }

      const result = (await response.json()) as PushResult;
      setState({
        phase: "done",
        message: `${result.created ? "Created" : "Updated"} in Figma${summarizeCounts(result.counts)}.`,
        warnings: [...warnings, ...(result.warnings ?? [])],
      });
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : copy.pushFailed,
      });
    }
  }

  const pushing = state.phase === "pushing";
  const pulling = pullState.phase === "pulling";

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="flex-1 gap-1.5 text-xs"
          disabled={!connected || pushing}
          title={connected ? undefined : copy.disconnectedTitle}
          onClick={() => void push()}
          data-testid="figma-push"
        >
          {pushing ? (
            <Loader2Icon className={cn("size-3.5", "animate-spin")} />
          ) : (
            <SendIcon className="size-3.5" />
          )}
          {pushing ? copy.pushing : copy.push}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="flex-1 gap-1.5 text-xs"
          disabled={!connected || pulling}
          title={connected ? undefined : copy.disconnectedTitle}
          onClick={() => void pull()}
          data-testid="figma-pull"
        >
          {pulling ? (
            <Loader2Icon className={cn("size-3.5", "animate-spin")} />
          ) : (
            <DownloadIcon className="size-3.5" />
          )}
          {pulling ? copy.pulling : copy.pull}
        </Button>
      </div>
      {state.phase === "done" ? (
        <span
          className="inline-flex items-start gap-1 text-xs text-muted-foreground"
          role="status"
          title={state.warnings.join("\n") || undefined}
        >
          {state.warnings.length > 0 ? (
            <AlertTriangleIcon className="size-3.5 shrink-0 text-amber-500" />
          ) : (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-600" />
          )}
          <span>
            {state.message}
            {state.warnings.length > 0
              ? ` ${state.warnings.length} warning(s).`
              : ""}
          </span>
        </span>
      ) : null}
      {state.phase === "error" ? (
        <span
          className="inline-flex items-start gap-1 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          <span>{state.message}</span>
        </span>
      ) : null}
      {pullState.phase === "error" ? (
        <span
          className="inline-flex items-start gap-1 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          <span>{pullState.message}</span>
        </span>
      ) : null}
      {pullState.phase === "done" ? (
        <div
          className="flex items-start gap-1.5 rounded-md border border-emerald-600/40 bg-emerald-500/10 px-2.5 py-2 text-xs font-medium"
          role="status"
        >
          <CheckIcon className="size-3.5 shrink-0 text-emerald-600" />
          <span>{copy.pulledToChat}</span>
        </div>
      ) : null}
    </div>
  );
}

export { FigmaSyncControls };
