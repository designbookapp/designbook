/**
 * The figma integration's HOME in the full view: a props-panel SECTION
 * appended below the core prop controls (docs/specs/props-panel.md §Plugin
 * sections, docs/specs/figma-section.md). It replaces the retired left-rail
 * Figma tab (the full-view migration deleted the tab host) and lets a designer
 * push the SELECTED component to Figma or pull a designer's edits back — right
 * next to the component's props (docs/specs/figma-integration-plugin.md
 * §Full-view home).
 *
 * Rendered ONLY when the figma integration is configured (the registry is
 * empty otherwise — the section seam guarantees this), so this file never
 * touches core UI internals: it consumes strictly the resolved
 * `PropsPanelSectionContext` (file/export/props + the live selection handles +
 * `openChat`) plus the curated `@designbook-ui/integrations` surface.
 *
 * Layout (top to bottom, matching the props panel's dbproto language):
 *   1. connection row — bridge connected/not (polled from `/api/x/figma/status`)
 *      plus the open Figma file/page when the plugin reported them;
 *   2. baseline row — whether this component has a pushed baseline
 *      (`.designbook/figma/<id>.json`) + its last-push time when readable;
 *   3. actions — Push (serialize the live selection → `/api/x/figma/push`) and
 *      Pull (`/api/x/figma/pull` → draft the Pi handoff prompt into chat).
 */

import { useEffect, useMemo, useState } from "react";
import {
  getAdapterRuntime,
  getIntegrationOptions,
  getTokenSources,
  repoPathFromGlobKey,
  type PropsPanelSectionProps,
} from "@designbook-ui/integrations";
import { buildNameMap, type NameMap } from "../shared/figmaTokens";
import { formatPullPrompt } from "../shared/figmaPullPrompt";
import type { PullRenderContext } from "../shared/figmaRender";
import { serializeComponent } from "./serialize";
import {
  attributionTokens,
  resolveTokenOptions,
  type AttributionToken,
} from "./figmaTokenSync";

const STATUS_POLL_MS = 5_000;

const copy = {
  connected: "Plugin connected",
  disconnected: "No plugin connected",
  disconnectedHint: "Open the designbook plugin in Figma to enable push/pull.",
  unresolvable:
    "Select a component instance on the canvas to push it (this selection has no live render).",
  push: "Push to Figma",
  pushing: "Pushing…",
  pull: "Pull changes",
  pulling: "Pulling…",
  notConnected:
    "No Figma plugin connected — open the designbook plugin in Figma and try again.",
  previewMissing: "Could not find the selection's live render to serialize.",
  pushFailed: "Push to Figma failed.",
  pullFailed: "Pull from Figma failed.",
  neverPushed: "This component has no Figma push yet — push it to Figma first.",
  pulledToChat: "Figma target drafted into chat — review and send.",
  baselinePushed: "Pushed baseline saved",
  baselineNone: "No baseline pushed yet",
};

type FigmaStatus = { connected: boolean; fileName?: string; page?: string };

type StatusPayload = {
  connected?: boolean;
  info?: { fileName?: string; page?: string } | null;
};

/** Polls the bridge status route (same signal the actions gate on). */
function useFigmaStatus(apiUrl: (path: string) => string): FigmaStatus {
  const [status, setStatus] = useState<FigmaStatus>({ connected: false });
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(apiUrl("/api/x/figma/status"));
        const payload = response.ok
          ? ((await response.json()) as StatusPayload)
          : undefined;
        if (active) {
          setStatus({
            connected: Boolean(payload?.connected),
            fileName: payload?.info?.fileName,
            page: payload?.info?.page,
          });
        }
      } catch {
        if (active) setStatus({ connected: false });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [apiUrl]);
  return status;
}

type BaselineState =
  | { phase: "unknown" }
  | { phase: "none" }
  | { phase: "present"; pushedAt?: string };

/**
 * Best-effort baseline probe: does `.designbook/figma/<entryId>.json` exist,
 * and (cheaply) when was it last pushed? Read through the existing read-only
 * `/api/file` route — a 404 means no baseline. Never blocks the actions.
 */
function useBaseline(
  apiUrl: (path: string) => string,
  entryId: string | undefined,
): BaselineState {
  const [state, setState] = useState<BaselineState>({ phase: "unknown" });
  useEffect(() => {
    if (!entryId) {
      setState({ phase: "unknown" });
      return;
    }
    let active = true;
    void (async () => {
      try {
        const path = `.designbook/figma/${entryId}.json`;
        const response = await fetch(
          apiUrl(`/api/file?path=${encodeURIComponent(path)}`),
        );
        if (!active) return;
        if (!response.ok) {
          setState({ phase: "none" });
          return;
        }
        const payload = (await response.json()) as { content?: string };
        let pushedAt: string | undefined;
        try {
          const parsed = JSON.parse(payload.content ?? "{}") as {
            pushedAt?: string;
            meta?: { pushedAt?: string };
          };
          pushedAt = parsed.meta?.pushedAt ?? parsed.pushedAt;
        } catch {
          // Present but unparseable — still a baseline.
        }
        setState({ phase: "present", ...(pushedAt ? { pushedAt } : {}) });
      } catch {
        if (active) setState({ phase: "unknown" });
      }
    })();
    return () => {
      active = false;
    };
  }, [apiUrl, entryId]);
  return state;
}

/**
 * Resolved figma token config for push attribution: target collection + the
 * name map (rule + optional repo name-map file). Mirrors the retired
 * FigmaPanel's resolution but keyed off the neutral token-source registry.
 */
function useTokenConfig(apiUrl: (path: string) => string): {
  collection: string;
  tokens: AttributionToken[];
} {
  const source = getTokenSources()[0];
  const options = useMemo(
    () =>
      resolveTokenOptions(
        (getIntegrationOptions("figma") ?? {}).tokens,
        source,
      ),
    [source],
  );
  const [overrides, setOverrides] = useState<Record<string, string>>();
  useEffect(() => {
    if (!options.nameMapFile) {
      setOverrides(undefined);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const response = await fetch(
          apiUrl(
            `/api/file?path=${encodeURIComponent(
              repoPathFromGlobKey(options.nameMapFile!),
            )}`,
          ),
        );
        if (!response.ok) return;
        const payload = (await response.json()) as { content?: string };
        const parsed = JSON.parse(payload.content ?? "{}") as unknown;
        if (active && parsed && typeof parsed === "object") {
          setOverrides(parsed as Record<string, string>);
        }
      } catch {
        // Missing/invalid map file falls back to the rule-only name map.
      }
    })();
    return () => {
      active = false;
    };
  }, [apiUrl, options.nameMapFile]);

  const nameMap: NameMap = useMemo(
    () => buildNameMap({ rule: options.nameRule, overrides }),
    [options.nameRule, overrides],
  );
  const tokens = useMemo(
    () => attributionTokens(getTokenSources(), nameMap),
    [nameMap],
  );
  return { collection: options.collection, tokens };
}

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

/** Every OTHER active adapter dimension (flags etc.) for the root marker. */
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

type PushState =
  | { phase: "idle" }
  | { phase: "pushing" }
  | { phase: "done"; message: string; warnings: string[] }
  | { phase: "error"; message: string };

type PullState =
  | { phase: "idle" }
  | { phase: "pulling" }
  | { phase: "done" }
  | { phase: "error"; message: string };

type PushResult = {
  nodeId?: string;
  created?: boolean;
  counts?: Record<string, number>;
  warnings?: string[];
};

type PullResultPayload = {
  componentId: string;
  html: string;
  render?: PullRenderContext;
};

function summarizeCounts(counts: Record<string, number> | undefined): string {
  if (!counts) return "";
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** Serialize-root Fiber type, borrowed off the serializer's own signature so
 *  this file needn't import React-internal fiber types. */
type SerializeEntryFiber = NonNullable<
  Parameters<typeof serializeComponent>[1]["entryFiber"]
>;

function FigmaSection({ context }: PropsPanelSectionProps) {
  const { apiUrl, openChat, live } = context;
  const status = useFigmaStatus(apiUrl);
  const baseline = useBaseline(apiUrl, live?.entryId);
  const { collection, tokens } = useTokenConfig(apiUrl);
  const [push, setPush] = useState<PushState>({ phase: "idle" });
  const [pull, setPull] = useState<PullState>({ phase: "idle" });

  const componentName =
    context.componentName ?? context.exportName ?? "component";
  // Push needs the live render (a DOM anchor + fiber) AND a registry id.
  const serializable = Boolean(live?.entryId && live?.root && live?.fiber);
  const canPush = status.connected && serializable && push.phase !== "pushing";
  const canPull =
    status.connected &&
    Boolean(live?.entryId) &&
    Boolean(openChat) &&
    pull.phase !== "pulling";

  const pushTitle = !status.connected
    ? copy.disconnectedHint
    : !serializable
      ? copy.unresolvable
      : undefined;
  const pullTitle = !status.connected ? copy.disconnectedHint : undefined;

  async function runPush() {
    if (!live?.entryId || !live.root || !live.fiber) {
      setPush({ phase: "error", message: copy.previewMissing });
      return;
    }
    setPush({ phase: "pushing" });
    try {
      const { tree, warnings } = await serializeComponent(live.root as Element, {
        componentId: live.entryId,
        componentName,
        entryFiber: live.fiber as SerializeEntryFiber,
        meta: {
          locale: dimensionValue("locale") ?? "en-US",
          variant: dimensionValue("variant") ?? "default",
          mode: dimensionValue("mode") ?? "light",
          collection: tokens.length > 0 ? collection : undefined,
          dimensions: otherDimensionValues(),
        },
        tokens,
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
      setPush({
        phase: "done",
        message: `${result.created ? "Created" : "Updated"} in Figma${summarizeCounts(result.counts)}.`,
        warnings: [...warnings, ...(result.warnings ?? [])],
      });
    } catch (error) {
      setPush({
        phase: "error",
        message: error instanceof Error ? error.message : copy.pushFailed,
      });
    }
  }

  async function runPull() {
    if (!live?.entryId || !openChat) return;
    setPull({ phase: "pulling" });
    try {
      const response = await fetch(apiUrl("/api/x/figma/pull"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ componentId: live.entryId }),
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
      // Draft the prompt into the live conversation's composer — the user's
      // send click there is the single confirm gate (no auto-send, no second
      // panel). The current source is NOT inlined: the figma-pull skill has Pi
      // read the file.
      openChat(
        formatPullPrompt({
          componentId: live.entryId,
          sourcePath: context.file,
          html,
          render,
        }),
      );
      setPull({ phase: "done" });
    } catch (error) {
      setPull({
        phase: "error",
        message: error instanceof Error ? error.message : copy.pullFailed,
      });
    }
  }

  return (
    <div className="dbfigma">
      <div className="dbfigma-status">
        <span
          aria-hidden
          className={`dbfigma-dot ${status.connected ? "on" : ""}`}
        />
        <span className="dbfigma-status-label">
          {status.connected ? copy.connected : copy.disconnected}
        </span>
        {status.connected && (status.fileName || status.page) ? (
          <span className="dbfigma-status-file" title={status.fileName}>
            {[status.fileName, status.page].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </div>
      {!status.connected ? (
        <div className="dbfigma-hint">{copy.disconnectedHint}</div>
      ) : null}

      <div className="dbfigma-baseline">
        <span className="dbfigma-prop-badge">baseline</span>
        <span>
          {baseline.phase === "present"
            ? baseline.pushedAt
              ? `${copy.baselinePushed} · ${new Date(baseline.pushedAt).toLocaleString()}`
              : copy.baselinePushed
            : baseline.phase === "none"
              ? copy.baselineNone
              : "—"}
        </span>
      </div>

      <div className="dbfigma-actions">
        <button
          type="button"
          className="dbfigma-btn"
          disabled={!canPush}
          title={pushTitle}
          onClick={() => void runPush()}
          data-testid="figma-section-push"
        >
          {push.phase === "pushing" ? copy.pushing : copy.push}
        </button>
        <button
          type="button"
          className="dbfigma-btn"
          disabled={!canPull}
          title={pullTitle}
          onClick={() => void runPull()}
          data-testid="figma-section-pull"
        >
          {pull.phase === "pulling" ? copy.pulling : copy.pull}
        </button>
      </div>

      {push.phase === "done" ? (
        <div
          className={`dbfigma-msg ${push.warnings.length > 0 ? "warn" : "ok"}`}
          role="status"
          title={push.warnings.join("\n") || undefined}
        >
          {push.message}
          {push.warnings.length > 0
            ? ` ${push.warnings.length} warning(s).`
            : ""}
        </div>
      ) : null}
      {push.phase === "error" ? (
        <div className="dbfigma-msg err" role="alert">
          {push.message}
        </div>
      ) : null}
      {pull.phase === "error" ? (
        <div className="dbfigma-msg err" role="alert">
          {pull.message}
        </div>
      ) : null}
      {pull.phase === "done" ? (
        <div className="dbfigma-msg ok" role="status">
          {copy.pulledToChat}
        </div>
      ) : null}
    </div>
  );
}

export { FigmaSection };
