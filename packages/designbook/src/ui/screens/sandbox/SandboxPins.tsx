/**
 * Pin presence chrome (docs/specs/sandbox.md §4):
 *
 *   - `SandboxPinBubbles` — Figma-comment-style bubbles over the App-page
 *     frame (expanded workbench), one per active pin whose LIVE anchor
 *     element is still connected. The rect re-resolves per render tick (the
 *     anchor is transient; the pin's identity is its code target). An
 *     unmounted/off-route pin simply has no bubble — it lives in the tray.
 *   - `SandboxPagePinBubbles` — the PAGE-MODE (collapsed toolbar) sibling:
 *     same bubbles over the live app DOM at raw viewport coords (identity
 *     transform, `position: fixed`) inside the page-tools shadow host.
 *   - `SandboxPinsTray` — the bottom-bar overflow: ALWAYS lists every active
 *     (unresolved) pin with its status; clicking opens the sandbox canvas.
 *     Routing differs per surface, so the caller supplies `onOpenPin`.
 */

import { useEffect, useState } from "react";
import { CircleAlertIcon, PinIcon } from "lucide-react";
import { Spinner } from "@designbook-ui/components/ui/spinner";
import { cn } from "@designbook-ui/lib/utils";
import { useFrameModel } from "@designbook-ui/models/frame/FrameProvider";
import { frameLocalRectToScreenRect } from "@designbook-ui/previewHost";
import { useCatalogModel } from "@designbook-ui/models/catalog/CatalogProvider";
import {
  activePins,
  conflictedPinIds,
  pinStatus,
  readyCounts,
  type SandboxPinState,
} from "@designbook-ui/models/sandbox/sandboxModel";
import { useSandboxApi } from "@designbook-ui/models/sandbox/SandboxProvider";
import { useStageElement } from "../stageContext";

const copy = {
  conflict: "conflict",
  conflictTitle:
    "Two changesets modify this export — open the thread to choose or compose.",
  openPin: (name: string) => `Open sandbox for ${name}`,
  trayLabel: "Sandbox pins",
};

/** Layout-drift tracking cadence for bubble rects (no live rect events). */
const BUBBLE_TICK_MS = 1000;

function statusBadge(pin: SandboxPinState) {
  const status = pinStatus(pin);
  if (status === "generating" || status === "working") {
    return <Spinner className="size-3" />;
  }
  if (status === "failed") {
    return <CircleAlertIcon className="size-3 text-destructive" />;
  }
  const counts = readyCounts(pin);
  return counts.ready > 0 ? (
    <span className="text-[10px] font-semibold">{counts.ready}</span>
  ) : (
    <PinIcon className="size-3" />
  );
}

/** Coarse re-render tick so bubbles follow app layout/scroll drift. */
function useBubbleTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => setTick((current) => current + 1),
      BUBBLE_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, []);
}

function BubbleButton({
  pin,
  left,
  top,
  fixed,
  onOpen,
}: {
  pin: SandboxPinState;
  left: number;
  top: number;
  fixed: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={copy.openPin(pin.target.name)}
      title={pin.target.name}
      className={cn(
        "pointer-events-auto z-40 flex size-6 cursor-default items-center justify-center rounded-full rounded-bl-none border bg-primary text-primary-foreground shadow-md hover:scale-110",
        fixed ? "fixed" : "absolute",
      )}
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onOpen}
    >
      {statusBadge(pin)}
    </button>
  );
}

/** App-page bubbles (expanded workbench): frame-local → stage-space rects. */
function SandboxPinBubbles() {
  const api = useSandboxApi();
  const { iframe } = useFrameModel();
  const stageEl = useStageElement();
  const { navigateSandbox } = useCatalogModel();
  useBubbleTick();
  if (!api || !iframe || !stageEl) return null;

  const stageBounds = stageEl.getBoundingClientRect();
  const bubbles = activePins(api.pins).flatMap((pin) => {
    const anchor = api.getPinAnchor(pin.id);
    if (!anchor || !anchor.isConnected) return [];
    const screenBox = frameLocalRectToScreenRect(
      iframe,
      anchor.getBoundingClientRect(),
    );
    if (!screenBox || screenBox.width === 0) return [];
    return [
      {
        pin,
        left: screenBox.x + screenBox.width - stageBounds.x - 10,
        top: screenBox.y - stageBounds.y - 10,
      },
    ];
  });

  return (
    <>
      {bubbles.map(({ pin, left, top }) => (
        <BubbleButton
          key={pin.id}
          pin={pin}
          left={left}
          top={top}
          fixed={false}
          onOpen={() => navigateSandbox(pin.id)}
        />
      ))}
    </>
  );
}

/**
 * Page-mode bubbles (collapsed toolbar view): the live app DOM IS the
 * surface, so anchors measure directly in viewport space — identity
 * transform, `position: fixed` inside the page-tools shadow host.
 */
function SandboxPagePinBubbles({
  onOpenPin,
}: {
  onOpenPin: (pinId: string) => void;
}) {
  const api = useSandboxApi();
  useBubbleTick();
  if (!api) return null;

  const bubbles = activePins(api.pins).flatMap((pin) => {
    const anchor = api.getPinAnchor(pin.id);
    if (!anchor || !anchor.isConnected) return [];
    const rect = anchor.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return [];
    return [{ pin, left: rect.x + rect.width - 10, top: rect.y - 10 }];
  });

  return (
    <>
      {bubbles.map(({ pin, left, top }) => (
        <BubbleButton
          key={pin.id}
          pin={pin}
          left={left}
          top={top}
          fixed
          onOpen={() => onOpenPin(pin.id)}
        />
      ))}
    </>
  );
}

/** Bottom-bar tray: all active pins + statuses, always. Surface-agnostic —
 * the caller routes `onOpenPin` (catalog router / page-mode escalation). */
function SandboxPinsTray({
  onOpenPin,
  className,
}: {
  onOpenPin: (pinId: string) => void;
  /** Positioning override (page mode uses `fixed`; workbench the default). */
  className?: string;
}) {
  const api = useSandboxApi();
  if (!api) return null;
  const pins = activePins(api.pins);
  if (pins.length === 0) return null;
  // O3: pins whose active changeset shares its export with another (badge).
  const conflicted = conflictedPinIds(api.changesets);

  return (
    <nav
      aria-label={copy.trayLabel}
      className={cn(
        "pointer-events-auto absolute bottom-3 left-3 z-20 flex max-w-[60%] items-center gap-1.5 overflow-x-auto rounded-lg border bg-background p-1 shadow-md",
        className,
      )}
    >
      {pins.map((pin) => {
        const status = pinStatus(pin);
        const counts = readyCounts(pin);
        return (
          <button
            key={pin.id}
            type="button"
            className={cn(
              "flex shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground",
              status === "failed" && "text-destructive",
            )}
            onClick={() => onOpenPin(pin.id)}
          >
            {statusBadge(pin)}
            <span className="max-w-32 truncate">{pin.target.name}</span>
            {counts.total > 0 ? (
              <span className="text-[10px] text-muted-foreground">
                {counts.ready}/{counts.total}
              </span>
            ) : null}
            {conflicted.has(pin.id) ? (
              <span
                title={copy.conflictTitle}
                className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              >
                {copy.conflict}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

export { SandboxPagePinBubbles, SandboxPinBubbles, SandboxPinsTray };
