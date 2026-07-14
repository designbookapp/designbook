/**
 * Shared pin-target pipeline for the sandbox prompt surfaces — the on-canvas
 * `SandboxPromptBox` and the proto full-view chat panel drive the SAME
 * selection → pin resolution (docs/specs/sandbox.md): reuse the unresolved
 * pin for the exact instance, or capture + create one (an ELEMENT pin for a
 * drilled DOM selection, a COMPONENT pin otherwise). Extracted from
 * `SandboxPromptBox` so the chat panel never forks a second pipeline.
 */

import { buildElementLocator } from "@designbook-ui/models/sandbox/capture";
import {
  captureElementFromHit,
  captureFromHit,
} from "@designbook-ui/models/sandbox/captureLive";
import type {
  SandboxPinState,
  SandboxState,
} from "@designbook-ui/models/sandbox/sandboxModel";
import type { SandboxApi } from "@designbook-ui/models/sandbox/SandboxProvider";
import { canvasHitLabel, type CanvasHitResult } from "../CanvasOverlay";

/** The selection a prompt surface acts on — resolvable from either surface's
 * hit shape (page mode's `PageHit` or the App page's `CanvasHitResult`). */
type SandboxSelection = {
  /** Registry entry identity — ABSENT for a source-resolved owner (an
   * unregistered authoring component, e.g. a page shell). */
  entryId?: string;
  label: string;
  /** Owner source path. Absent/"" for a source owner the client could not
   * resolve — the pin route then resolves it from `ownerNames` node-side. */
  sourcePath?: string;
  /** Component export resolution: the entry key (exportName overrides). */
  key: string;
  exportName?: string;
  /** Stable per-instance id (pin identity's instance path). */
  instanceId: string;
  /** Live fiber — feeds props/context capture at pin time. */
  fiber?: unknown;
  /** Live anchor element — registered for bubble rect re-resolution. */
  anchor?: Element;
  /**
   * Set when the selection is a drilled DOM ELEMENT inside the owner
   * component (docs/specs/sandbox.md v2): prompting creates an ELEMENT pin
   * (owner identity + element locator) instead of a component pin. The
   * `entryId`/`sourcePath`/`exportName` above describe the OWNER.
   */
  element?: Element;
  /** "entry" = registered owner (default); "source" = unregistered authoring
   * component resolved by the fiber owner walk (sourceOwner.ts). */
  ownerKind?: "entry" | "source";
  /** Named-owner chain, nearest first (source owners — server resolution). */
  ownerNames?: string[];
};

/** An App-page frame hit as a `SandboxSelection` (the exact mapping the frame
 * overlay feeds the prompt box; the proto chat panel shares it). */
function frameHitToSandboxSelection(hit: CanvasHitResult): SandboxSelection {
  return {
    entryId: hit.entry.id || undefined,
    label: hit.kind === "dom" ? canvasHitLabel(hit) : hit.entry.label,
    sourcePath: hit.entry.sourcePath || undefined,
    key: hit.entry.key,
    exportName:
      hit.kind === "dom"
        ? (hit.codeTarget?.ownerExportName ?? hit.entry.exportName)
        : hit.entry.exportName,
    instanceId: hit.instanceId,
    fiber: hit.fiber,
    anchor: hit.anchor,
    ownerKind: hit.ownerKind,
    ownerNames: hit.ownerNames,
    ...(hit.kind === "dom" && hit.anchor ? { element: hit.anchor } : {}),
  };
}

/** The reusable UNRESOLVED pin for this exact instance, if one exists. When
 * the client has no sourcePath the instance id alone identifies it (the
 * server chose the file). */
function findReusablePin(
  pins: SandboxState,
  selection: SandboxSelection,
): SandboxPinState | undefined {
  return Object.values(pins).find(
    (pin) =>
      !pin.resolved &&
      pin.target.instancePath === selection.instanceId &&
      (selection.sourcePath ? pin.target.file === selection.sourcePath : true),
  );
}

/**
 * Capture the selection and create its pin: an ELEMENT pin for a drilled DOM
 * element (owner identity + element locator, v2), a COMPONENT pin otherwise.
 * Registers the transient live anchor on success (bubble rect re-resolution).
 */
async function createSelectionPin(
  api: SandboxApi,
  selection: SandboxSelection,
): Promise<{ id?: string; error?: string }> {
  // Awaits the adapter runtime when a pin races the mount bootstrap
  // (page-mode cold load) — see captureLive.adapterStateSnapshot.
  const hit = {
    kind: selection.element ? ("dom" as const) : ("component" as const),
    name: selection.label,
    instanceId: selection.instanceId,
    entry: {
      id: selection.entryId ?? "",
      label: selection.label,
      sourcePath: selection.sourcePath ?? "",
      key: selection.key,
      exportName: selection.exportName,
    },
    fiber: selection.fiber,
  };
  let created: Awaited<ReturnType<SandboxApi["createPin"]>>;
  if (selection.element) {
    const captured = await captureElementFromHit(hit, selection.element);
    created = await api.createPin({
      target: captured.target,
      contextSnapshot: captured.contextSnapshot,
      kind: "element",
      locator: captured.locator,
      // Source-resolved owners: the server picks the file from this chain
      // when the client-side sourcePath is "" (sourceOwner.ts).
      ...(selection.ownerNames?.length
        ? { ownerNames: selection.ownerNames }
        : {}),
    });
  } else {
    // COMPONENT pins keep the original capture, plus a best-effort locator
    // off the live anchor (U5: the in-place preview re-resolves the element
    // after the reload a variant landing triggers).
    const anchor = selection.anchor;
    created = await api.createPin({
      ...(await captureFromHit(hit)),
      ...(anchor
        ? {
            locator: buildElementLocator({
              tag: anchor.tagName,
              outerHtml: anchor.outerHTML,
              textContent: anchor.textContent ?? "",
              ...(typeof (anchor as HTMLElement).className === "string" &&
              (anchor as HTMLElement).className
                ? { className: (anchor as HTMLElement).className }
                : {}),
            }),
          }
        : {}),
    });
  }
  if (created.error || !created.id) {
    return { error: created.error ?? "Could not create the pin." };
  }
  // Transient live anchor → the bubble can track this instance's rect.
  if (selection.anchor) api.registerPinAnchor(created.id, selection.anchor);
  return { id: created.id };
}

/**
 * FRESH capture at send time (conversation-routed asks): re-run the pin
 * capture machinery over the live selection WITHOUT creating a pin — the
 * snapshot rides the prompt so a REUSED pin never serves a stale capture.
 * Undefined = capture unavailable (dead fiber etc.) — the server keeps the
 * pin's previous snapshot.
 */
async function captureSelectionSnapshot(
  selection: SandboxSelection,
): Promise<unknown | undefined> {
  const hit = {
    kind: selection.element ? ("dom" as const) : ("component" as const),
    name: selection.label,
    instanceId: selection.instanceId,
    entry: {
      id: selection.entryId ?? "",
      label: selection.label,
      sourcePath: selection.sourcePath ?? "",
      key: selection.key,
      exportName: selection.exportName,
    },
    fiber: selection.fiber,
  };
  try {
    if (selection.element) {
      return (await captureElementFromHit(hit, selection.element))
        .contextSnapshot;
    }
    return (await captureFromHit(hit)).contextSnapshot;
  } catch {
    return undefined;
  }
}

export {
  captureSelectionSnapshot,
  createSelectionPin,
  findReusablePin,
  frameHitToSandboxSelection,
};
export type { SandboxSelection };
