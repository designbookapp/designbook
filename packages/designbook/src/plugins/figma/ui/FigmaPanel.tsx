/**
 * The figma integration's left-rail tab (a PluginScreenProps Screen).
 * SELF-CONTAINED on purpose — this is plugin UI, so it keeps its own section
 * markup (no PanelSection) and consumes core strictly through the integration
 * seam props + `@designbook-ui/integrations`.
 *
 * Layout (top to bottom, matching the Files/Changes panel language):
 *   1. header — panel title + a one-line hint;
 *   2. connection block — plugin connected/not (polled from
 *      `/api/x/figma/status` here, handed to the controls as a prop) plus the
 *      open Figma file/page when the plugin reported them;
 *   3. component section — the open canvas component (name + source path)
 *      with the Push/Pull actions, or a muted hint when nothing is open;
 *   4. variables section — Sync to/from Figma over the NEUTRAL token sources
 *      adapters published (G2a: these buttons moved here from the Theme tab).
 */

import { useEffect, useMemo, useState } from "react";
import { cn } from "@designbook-ui/lib/utils";
import { Button } from "@designbook-ui/components/ui/button";
import {
  getIntegrationOptions,
  repoPathFromGlobKey,
  type PluginScreenProps,
  type TokenSource,
} from "@designbook-ui/integrations";
import {
  buildNameMap,
  type FigmaCollection,
  type NameMap,
} from "../shared/figmaTokens";
import { FigmaSyncControls } from "./FigmaSyncControls";
import {
  attributionTokens,
  collectionForPush,
  diffPulledCollection,
  resolveTokenOptions,
} from "./figmaTokenSync";

const copy = {
  componentHeading: "Component",
  connectedLabel: "Plugin connected",
  connectionHeading: "Connection",
  disconnectedHint: "Open the designbook plugin in Figma to enable sync.",
  disconnectedLabel: "No plugin connected",
  emptyHint: "Open a component on the canvas to sync it with Figma.",
  entryHint: "Push the open component to Figma, or pull back designer edits.",
  noTokens: "No theme-token source registered — add a theme adapter to sync variables.",
  syncFrom: "Sync from Figma",
  syncTo: "Sync to Figma",
  syncing: "Syncing…",
  title: "Figma",
  variablesHeading: "Variables",
};

const STATUS_POLL_MS = 5_000;

type FigmaStatus = {
  connected: boolean;
  /** Open Figma file/page, when the plugin's hello reported them. */
  fileName?: string;
  page?: string;
};

type StatusPayload = {
  connected?: boolean;
  info?: { fileName?: string; page?: string } | null;
};

/** Polls the figma status route (same signal the sync actions use). */
function useFigmaStatus(apiUrl: PluginScreenProps["apiUrl"]): FigmaStatus {
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

/**
 * Resolved figma token config: target collection + NameMap (rule + optional
 * repo name-map file, fetched once).
 */
function useFigmaTokenConfig(
  apiUrl: PluginScreenProps["apiUrl"],
  source: TokenSource | undefined,
): { collection: string; nameMap: NameMap } {
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

  const nameMap = useMemo(
    () => buildNameMap({ rule: options.nameRule, overrides }),
    [options.nameRule, overrides],
  );
  return { collection: options.collection, nameMap };
}

/** Section header matching the Files panel's heading style. */
function SectionHeading({ children }: { children: string }) {
  return <h2 className="text-sm font-semibold">{children}</h2>;
}

function ConnectionBlock({ status }: { status: FigmaStatus }) {
  const fileLine = [status.fileName, status.page].filter(Boolean).join(" · ");
  return (
    <div className="grid gap-1">
      <SectionHeading>{copy.connectionHeading}</SectionHeading>
      <div className="grid gap-1 rounded-md border p-3">
        <span className="flex items-center gap-2 text-xs font-medium">
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              status.connected ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
          {status.connected ? copy.connectedLabel : copy.disconnectedLabel}
        </span>
        {status.connected && fileLine ? (
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {fileLine}
          </p>
        ) : null}
        {!status.connected ? (
          <p className="text-xs text-muted-foreground">
            {copy.disconnectedHint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

type SyncUiState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "done"; message: string }
  | { phase: "error"; message: string };

/**
 * "Sync to Figma" / "Sync from Figma" over the neutral token sources (G2a):
 * push writes the resolved token model as a variable collection; pull writes
 * changed variable values back through `source.setToken`.
 */
function VariablesSection({
  apiUrl,
  connected,
  source,
  collection,
  nameMap,
}: {
  apiUrl: PluginScreenProps["apiUrl"];
  connected: boolean;
  source: TokenSource | undefined;
  collection: string;
  nameMap: NameMap;
}) {
  const [state, setState] = useState<SyncUiState>({ phase: "idle" });

  async function run(action: () => Promise<string>) {
    setState({ phase: "busy" });
    try {
      setState({ phase: "done", message: await action() });
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : "Sync failed.",
      });
    }
  }

  async function syncTo(): Promise<string> {
    const payload = collectionForPush(source!, collection, nameMap);
    const response = await fetch(apiUrl("/api/x/figma/variables"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status === 409) throw new Error("No Figma plugin connected.");
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(body.error ?? "Failed to push variables to Figma.");
    }
    const result = (await response.json()) as {
      created?: number;
      updated?: number;
      skippedModes?: string[];
    };
    const skipped = result.skippedModes ?? [];
    const note =
      skipped.length > 0
        ? ` This Figma plan limits collections to one mode, so ${skipped.join(", ")} ${skipped.length === 1 ? "was" : "were"} not synced.`
        : "";
    return `Pushed "${collection}": ${result.created ?? 0} created, ${result.updated ?? 0} updated.${note}`;
  }

  async function syncFrom(): Promise<string> {
    const response = await fetch(apiUrl("/api/x/figma/variables"), {
      method: "POST",
    });
    if (response.status === 409) throw new Error("No Figma plugin connected.");
    if (!response.ok) {
      throw new Error("Failed to read variables from Figma.");
    }
    const payload = (await response.json()) as {
      collections?: Array<{
        name: string;
        modes: string[];
        variables: Array<{
          name: string;
          resolvedType: "COLOR" | "FLOAT" | "STRING";
          valuesByMode: Record<string, unknown>;
        }>;
      }>;
    };
    const collections = payload.collections ?? [];
    const raw =
      collections.find((candidate) => candidate.name === collection) ??
      collections[0];
    if (!raw) throw new Error("Figma returned no variable collections.");

    const { changes, skipped } = diffPulledCollection(
      source!,
      {
        name: raw.name,
        modes: raw.modes,
        variables: raw.variables.map((variable) => ({
          name: variable.name,
          type: variable.resolvedType,
          valuesByMode:
            variable.valuesByMode as FigmaCollection["variables"][number]["valuesByMode"],
        })),
      },
      nameMap,
    );
    let written = 0;
    for (const change of changes) {
      await source!.setToken?.(change.mode, change.name, change.value);
      written++;
    }
    return `Pulled "${raw.name}": ${written} value(s) updated${skipped ? `, ${skipped} unmatched var(s) skipped` : ""}.`;
  }

  const busy = state.phase === "busy";
  const usable = connected && source !== undefined;

  return (
    <div className="grid gap-1">
      <SectionHeading>{copy.variablesHeading}</SectionHeading>
      {source ? (
        <div className="grid gap-2 rounded-md border p-3">
          <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {collection}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-1 text-xs"
              disabled={!usable || busy}
              title={connected ? undefined : copy.disconnectedHint}
              onClick={() => void run(syncTo)}
            >
              {busy ? copy.syncing : copy.syncTo}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="flex-1 text-xs"
              disabled={!usable || busy || !source.setToken}
              title={connected ? undefined : copy.disconnectedHint}
              onClick={() => void run(syncFrom)}
            >
              {busy ? copy.syncing : copy.syncFrom}
            </Button>
          </div>
          {state.phase === "done" ? (
            <p className="text-xs text-muted-foreground" role="status">
              {state.message}
            </p>
          ) : null}
          {state.phase === "error" ? (
            <p className="text-xs text-destructive" role="alert">
              {state.message}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{copy.noTokens}</p>
      )}
    </div>
  );
}

function FigmaPanel({ entry, apiUrl, openChat, tokenSources }: PluginScreenProps) {
  const status = useFigmaStatus(apiUrl);
  // Today the theme adapter publishes a single source; the first one drives
  // the variables section, all of them feed push attribution.
  const source = tokenSources[0];
  const { collection, nameMap } = useFigmaTokenConfig(apiUrl, source);

  return (
    <div className="grid content-start gap-3 p-4">
      <div className="grid gap-1">
        <SectionHeading>{copy.title}</SectionHeading>
        <p className="text-xs text-muted-foreground">
          {entry ? copy.entryHint : copy.emptyHint}
        </p>
      </div>
      <ConnectionBlock status={status} />
      <div className="grid gap-1">
        <SectionHeading>{copy.componentHeading}</SectionHeading>
        {entry ? (
          <div className="grid gap-2 rounded-md border p-3">
            <div className="grid gap-0.5">
              <span className="text-xs font-medium">{entry.label}</span>
              {entry.sourcePath ? (
                <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {entry.sourcePath}
                </p>
              ) : null}
            </div>
            <FigmaSyncControls
              connected={status.connected}
              apiUrl={apiUrl}
              entryId={entry.id}
              entryLabel={entry.label}
              sourcePath={entry.sourcePath}
              openChat={openChat}
              pushCollection={collection}
              pushTokens={attributionTokens(tokenSources, nameMap)}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{copy.emptyHint}</p>
        )}
      </div>
      <VariablesSection
        apiUrl={apiUrl}
        connected={status.connected}
        source={source}
        collection={collection}
        nameMap={nameMap}
      />
    </div>
  );
}

export { FigmaPanel };
