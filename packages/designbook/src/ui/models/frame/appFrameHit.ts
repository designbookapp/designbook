/**
 * Pure helpers for the App page frame cell's selection chip.
 *
 * The App-page counterpart of `pageTools/pageHit.ts`'s `buildPagePromptPrefill`/
 * `canGoToComponent`, adapted to `CanvasHitResult` (the canvas's hit shape)
 * instead of `PageHit` (the live-page one) — `pageTools` already depends on
 * `Workbench` (for `TextEditPopover`, `componentRegistry`, …), so `Workbench`
 * can't depend back on `pageTools` without a cycle. The two hit shapes carry the
 * same information; this is a small, independently-tested adaptation rather than
 * a shared import.
 */

import type { CanvasCodeTarget } from "@designbook-ui/types";

/** The slice of `CanvasHitResult` this module needs — kept minimal and DOM-free
 * so it's testable without importing the (React-carrying) component module. */
type FrameHit = {
  kind: "component" | "dom";
  name: string;
  entry: { id: string; label: string; sourcePath: string; key: string };
  codeTarget?: CanvasCodeTarget;
  dom?: { tag: string; id?: string; classes?: string[] };
  /** "entry" (default) = registered owner; "source" = unregistered authoring
   * component resolved by the owner fallback (entry.id "" and possibly
   * entry.sourcePath "" — the pin route resolves the file node-side). */
  ownerKind?: "entry" | "source";
  /** Live anchor element — structural (`unknown`) so this module stays
   * DOM-free; presence is what the sandbox guard checks. */
  anchor?: unknown;
};

/** css-ish label for a plain DOM hit: `tag#id` / `tag.class` / `tag`. */
function domLabel(dom: NonNullable<FrameHit["dom"]>): string {
  if (dom.id) return `${dom.tag}#${dom.id}`;
  if (dom.classes && dom.classes.length > 0) return `${dom.tag}.${dom.classes[0]}`;
  return dom.tag;
}

/** Whether "Go to component" applies — a component-level hit (not a plain DOM
 * drill level), mirroring the canvas context menu's own gate. */
function canGoToFrameComponent(hit: FrameHit): boolean {
  return hit.kind === "component" && hit.ownerKind !== "source";
}

/**
 * Whether the sandbox prompt box applies to an App-page frame hit — the
 * App-page twin of pageTools' `canPromptSandbox`: a registered component hit,
 * a drilled DOM element inside a registered owner, or a DOM element whose
 * UNREGISTERED authoring component resolved via the source-owner fallback
 * (`ownerKind: "source"`; sourcePath may be "" — resolved node-side).
 */
function canPromptFrameSandbox(hit: FrameHit): boolean {
  if (hit.kind === "component") return Boolean(hit.entry.sourcePath);
  if (!hit.anchor) return false;
  if (hit.entry.sourcePath) return true;
  return hit.ownerKind === "source" && Boolean(hit.entry.key);
}

/** Prefill text for the chat tab's Prompt Pi draft: a compact context header —
 * the file + usage line for a component hit, degrading to a DOM description
 * naming its owning component otherwise. */
function buildFramePromptPrefill(hit: FrameHit): string {
  if (hit.kind === "component") {
    const header = `Re: ${hit.entry.label}`;
    if (hit.codeTarget) {
      const cls = hit.codeTarget.className
        ? ` className="${hit.codeTarget.className}"`
        : "";
      return `${header}\nUsed in ${hit.codeTarget.file} as <${hit.codeTarget.name}${cls}>\n\n`;
    }
    return `${header} (${hit.entry.sourcePath})\n\n`;
  }
  const tag = hit.dom ? domLabel(hit.dom) : hit.name;
  return `Re: ${tag} element inside <${hit.entry.label}> (not a registered component)\n\n`;
}

export {
  buildFramePromptPrefill,
  canGoToFrameComponent,
  canPromptFrameSandbox,
  domLabel,
};
export type { FrameHit };
