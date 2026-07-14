/**
 * The app-mode sandbox prompt box (docs/specs/sandbox.md §4): a compact
 * Figma-comment-style box anchored under the selection. Prompting either runs
 * a DIRECT EDIT on the real source or generates N design variants into the
 * sandbox — both on the pin's own ephemeral session (D6), never the main chat.
 *
 * SURFACE-AGNOSTIC (page mode + App page): the caller supplies the resolved
 * selection (code target + transient fiber/anchor), the box position, and the
 * open-canvas action — page mode positions `fixed` at raw viewport coords and
 * escalates through the boot module; the App-page overlay positions
 * `absolute` in stage space and uses the catalog router. ADDITIVE next to the
 * existing selection chips (D1): nothing existing moves on either surface.
 *
 * Keyboard events stop at the box (page mode renders in a shadow host over
 * the LIVE app — typing must never reach the app's global shortcut handlers,
 * same discipline as the PageTools drawer).
 */

import { useState } from "react";
import { MessageSquarePlusIcon, PinIcon } from "lucide-react";
import { Button } from "@designbook-ui/components/ui/button";
import { Spinner } from "@designbook-ui/components/ui/spinner";
import { Textarea } from "@designbook-ui/components/ui/textarea";
import { cn } from "@designbook-ui/lib/utils";
import {
  pinStatus,
  readyCounts,
} from "@designbook-ui/models/sandbox/sandboxModel";
import { useSandboxApi } from "@designbook-ui/models/sandbox/SandboxProvider";
import {
  createSelectionPin,
  findReusablePin,
  type SandboxSelection,
} from "./promptTarget";

const copy = {
  capturedNote: "Variants render in this selection's captured state.",
  edit: "Edit",
  editHint: "Edits the real source file.",
  openCanvas: "Open sandbox",
  placeholder: "Change this component…",
  placeholderElement: "Change this element…",
  promptFirstPlaceholder: "Describe a change or ask for variations…",
  readyOf: (ready: number, total: number) => `${ready}/${total} ready`,
  send: "Send",
  variants: "Variants",
  working: "Working…",
};

type PromptMode = "edit" | "variants";

function SandboxPromptBox({
  selection,
  position,
  onOpenCanvas,
  surface = "canvas",
  onThreadOpened,
}: {
  selection: SandboxSelection;
  /** Box position + positioning mode: App page = absolute stage coords;
   * page mode = fixed viewport coords. */
  position: { left: number; top: number; mode: "absolute" | "fixed" };
  /** Open the sandbox canvas focused on this pin (surface-specific route). */
  onOpenCanvas: (pinId: string) => void;
  /**
   * UX v3 surface gate (U1): `"page"` = the collapsed-toolbar prompt-first
   * box — ONLY the selected-target label + one textarea; submit routes
   * through the intent classifier (/api/sandbox/ask, U3) and opens the
   * drawer thread via `onThreadOpened`. `"canvas"` (default) keeps the
   * original mode-button surface (App page/workbench) untouched.
   */
  surface?: "canvas" | "page";
  /** Page surface only: the prompt was accepted — open this pin's thread. */
  onThreadOpened?: (pinId: string) => void;
}) {
  const api = useSandboxApi();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<PromptMode>("variants");
  const [count, setCount] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const promptFirst = surface === "page";
  if (!api) return null;
  // A source-resolved owner may carry no client-side sourcePath — the pin
  // route resolves the file from `ownerNames` (element pins only).
  const sourceOwnerElement =
    selection.ownerKind === "source" && Boolean(selection.element);
  if (!selection.sourcePath && !sourceOwnerElement) return null;

  // Reuse the unresolved pin for this exact instance, if one exists.
  const existing = findReusablePin(api.pins, selection);
  const status = existing ? pinStatus(existing) : undefined;
  const counts = existing ? readyCounts(existing) : undefined;
  const busy = submitting || existing?.busy === true;

  async function submit() {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setSubmitting(true);
    setError(undefined);
    let pinId = existing?.id;
    if (!pinId) {
      // Shared capture + create pipeline (element pin for a drilled DOM
      // element, component pin otherwise) — see promptTarget.ts.
      const created = await createSelectionPin(api!, selection);
      if (created.error || !created.id) {
        setError(created.error);
        setSubmitting(false);
        return;
      }
      pinId = created.id;
    }
    // U3 (page surface): no modes — the server classifies variants-vs-turn
    // from the prompt; the drawer thread shows the routed activity.
    const result = promptFirst
      ? await api!.ask({ pinId, prompt })
      : await api!.prompt({
          pinId,
          prompt,
          mode,
          ...(mode === "variants" ? { n: count } : {}),
        });
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setText("");
    if (promptFirst) onThreadOpened?.(pinId);
  }

  return (
    <div
      className={cn(
        "pointer-events-auto z-50 grid w-80 gap-1.5 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md",
        position.mode === "fixed" ? "fixed" : "absolute",
      )}
      style={{ left: position.left, top: position.top }}
      onPointerDown={(event) => event.stopPropagation()}
      // Shadow-DOM isolation: keystrokes in the box must never leak to the
      // live app (or the page-tools Escape ladder) — see the drawer notes.
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1.5">
        <PinIcon className="size-3.5 shrink-0 text-muted-foreground" />
        {/* U1 (page surface): ONLY the selected-target label — the mode
            toggle + variant-count controls stay on the canvas surfaces. */}
        {promptFirst ? (
          <span className="min-w-0 truncate text-xs font-medium">
            {selection.label}
          </span>
        ) : (
          <>
            <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
              {(["variants", "edit"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    "cursor-default rounded-sm px-2 py-0.5 text-xs",
                    mode === option
                      ? "bg-background font-medium shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setMode(option)}
                >
                  {option === "variants" ? copy.variants : copy.edit}
                </button>
              ))}
            </div>
            {mode === "variants" ? (
              <div className="flex items-center gap-1">
                {[2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={cn(
                      "size-5 cursor-default rounded-sm text-[10px]",
                      count === n
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                    onClick={() => setCount(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
        {status === "generating" || busy ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
            <Spinner className="size-3" />
            {counts && counts.total > 0
              ? copy.readyOf(counts.ready, counts.total)
              : copy.working}
          </span>
        ) : null}
      </div>
      <Textarea
        value={text}
        rows={2}
        placeholder={
          promptFirst
            ? copy.promptFirstPlaceholder
            : selection.element
              ? copy.placeholderElement
              : copy.placeholder
        }
        className="min-h-0 text-xs"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {/* U1: the page surface is label + textarea ONLY — Return submits;
          send/mode chrome stays on the canvas surfaces. */}
      {promptFirst ? null : (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => void submit()}
          >
            {busy ? <Spinner /> : <MessageSquarePlusIcon />}
            {copy.send}
          </Button>
          {existing && existing.variants.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onOpenCanvas(existing.id)}
            >
              {copy.openCanvas}
            </Button>
          ) : null}
          <span className="ml-auto text-[10px] text-muted-foreground">
            {mode === "variants" ? copy.capturedNote : copy.editHint}
          </span>
        </div>
      )}
      {existing?.lastError ? (
        <span className="text-xs text-destructive">{existing.lastError}</span>
      ) : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export { SandboxPromptBox };
export type { SandboxSelection };
