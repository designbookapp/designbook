/**
 * The "figma" left tab. SELF-CONTAINED on purpose — this tab is slated to
 * become a plugin, so it keeps its own copy + section markup (no PanelSection)
 * and imports only the existing `FigmaSyncControls` (whose push/pull wiring
 * already works) plus shared primitives (Button-level shadcn bits are inside
 * FigmaSyncControls itself).
 *
 * Layout (top to bottom, matching the Files/Changes panel language):
 *   1. header — panel title + a one-line hint;
 *   2. connection block — plugin connected/not (polled from
 *      `/api/figma/status` here, handed to the controls as a prop) plus the
 *      open Figma file/page when the plugin reported them;
 *   3. component section — the open canvas component (name + source path)
 *      with the Push/Pull actions, or a muted hint when nothing is open.
 */

import { useEffect, useState } from "react";
import { cn } from "@designbook-ui/lib/utils";
import { apiUrl } from "@designbook-ui/designbook";
import { FigmaSyncControls } from "./FigmaSyncControls";

const copy = {
  componentHeading: "Component",
  connectedLabel: "Plugin connected",
  connectionHeading: "Connection",
  disconnectedHint: "Open the designbook plugin in Figma to enable sync.",
  disconnectedLabel: "No plugin connected",
  emptyHint: "Open a component on the canvas to sync it with Figma.",
  entryHint: "Push the open component to Figma, or pull back designer edits.",
  title: "Figma",
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

/** Polls `/api/figma/status` (same signal the theme tab's sync actions use). */
function useFigmaStatus(): FigmaStatus {
  const [status, setStatus] = useState<FigmaStatus>({ connected: false });

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(apiUrl("/api/figma/status"));
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
  }, []);

  return status;
}

/** The open canvas component the sync controls target (registry facts only —
 * kept structural so this file doesn't depend on the catalog model). */
type FigmaPanelEntry = {
  id: string;
  label: string;
  sourcePath?: string;
};

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

function FigmaPanel({
  entry,
  onAddToChat,
}: {
  entry?: FigmaPanelEntry;
  /** Drafts the pull prompt into the right panel's chat input (the user's
   * send click is the confirm gate). */
  onAddToChat: (prompt: string) => void;
}) {
  const status = useFigmaStatus();

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
              entryId={entry.id}
              entryLabel={entry.label}
              sourcePath={entry.sourcePath}
              onAddToChat={onAddToChat}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{copy.emptyHint}</p>
        )}
      </div>
    </div>
  );
}

export { FigmaPanel };
export type { FigmaPanelEntry };
