/**
 * Shared inline-edit mechanics for a keyed text claim.
 *
 * Extracted from `TextToolOverlay`'s original `beginInlineEdit` so the canvas
 * text tool and the App-page frame text tool (`AppFrameTextOverlay`) share ONE
 * implementation instead of forking it: canvas edits a node in the workbench's
 * own document/window; the frame tool edits a node that lives in the IFRAME's
 * own document/window (a different `Document`/`Window`/`Selection` realm). Both
 * are threaded in explicitly rather than reached via the ambient globals, so
 * the exact same logic works unmodified in either realm.
 *
 * Swaps the rendered text for its raw template (placeholders visible as
 * `{{name}}`), makes the owning element contenteditable, and commits on
 * blur/Enter; Escape (or an external `cancel()`, e.g. a frame navigation)
 * restores the original text. Only claims whose shape allows it get inline
 * editing at all — see `canInlineEditClaim`; anything else (placeholders split
 * across nodes, plurals, multi-node content) keeps the popover, on both paths.
 */

import { stripMarkers } from "@designbook-ui/previewHost";
import type { TextClaim } from "@designbookapp/designbook/config";

/**
 * Whether `claim`'s DOM shape allows in-place editing: a resolvable template +
 * key, AND the claimed text node is its parent element's ONLY child. Anything
 * more complex (a placeholder split across sibling nodes, mixed content) can't
 * be safely swapped for a raw template and back — the caller falls back to the
 * popover editor.
 */
function canInlineEditClaim(claim: TextClaim): boolean {
  if (
    claim.kind !== "keyed" ||
    !claim.node ||
    !claim.getTemplate ||
    !claim.key
  ) {
    return false;
  }
  const el = claim.node.parentElement;
  if (!el) return false;
  return el.childNodes.length === 1 && el.firstChild === claim.node;
}

type InlineEditCallbacks = {
  /** The committed plain-text value (markers stripped), only when it actually
   * changed from the template and isn't blank — the caller decides how to
   * persist it (e.g. `claim.save`, or reopening a popover for a plural claim,
   * exactly like the canvas's own `commitInlineEdit`). */
  onCommit: (value: string) => void;
  /** Fires when the edit ends for ANY reason (commit, Escape-cancel, or an
   * external `cancel()`) — the caller clears whatever local "editing" state it
   * renders while active. Called at most once per `beginInlineEdit` call. */
  onEnd: () => void;
  /**
   * Stop the Enter/Escape that ends the edit from reaching any ancestor
   * listener. Required inside a live app's frame: the edited
   * node is part of the APP's own DOM, so an ancestor shortcut handler would
   * otherwise also see the key. The canvas has no such ancestor and passes
   * `false` (default) to stay pixel-identical to its pre-extraction behavior.
   */
  stopPropagation?: boolean;
};

type InlineEditHandle = {
  /** Cancel the edit: restores the original text, tears down listeners, and
   * calls `onEnd` — idempotent (a second call is a no-op). Used by an Escape
   * ladder, or an external abort (e.g. the frame navigated away mid-edit). */
  cancel: () => void;
};

/**
 * Begins an inline edit for `claim` if its shape allows it (see
 * `canInlineEditClaim`); returns `undefined` with no side effects when it
 * doesn't, so the caller falls back to the popover editor. `doc`/`win` are the
 * `Document`/`Window` that own `claim.node` — the workbench's own for canvas,
 * the iframe's `contentDocument`/`contentWindow` for the frame tool.
 */
function beginInlineEdit(
  claim: TextClaim,
  doc: Document,
  win: Window,
  callbacks: InlineEditCallbacks,
): InlineEditHandle | undefined {
  if (!canInlineEditClaim(claim)) return undefined;
  const textNode = claim.node as Text;
  const el = textNode.parentElement as HTMLElement;
  const template = claim.getTemplate!(claim.key!);
  if (typeof template !== "string") return undefined;

  const original = textNode.data;
  let ended = false;

  const restoreDom = () => {
    for (const child of Array.from(el.childNodes)) {
      if (child !== textNode) child.remove();
    }
    if (textNode.parentNode !== el) {
      el.appendChild(textNode);
    }
    textNode.data = original;
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    el.removeEventListener("blur", onBlur);
    el.removeEventListener("keydown", onKeyDown);
    el.removeAttribute("contenteditable");
    callbacks.onEnd();
  };

  const onBlur = () => {
    const value = stripMarkers(el.textContent ?? "");
    finish();
    restoreDom();
    if (value !== template && value.trim() !== "") {
      callbacks.onCommit(value);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (callbacks.stopPropagation) event.stopPropagation();
      el.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (callbacks.stopPropagation) event.stopPropagation();
      finish();
      restoreDom();
    }
  };

  textNode.data = template;
  el.setAttribute("contenteditable", "plaintext-only");
  if (!el.isContentEditable) {
    el.setAttribute("contenteditable", "true");
  }
  el.addEventListener("blur", onBlur);
  el.addEventListener("keydown", onKeyDown);
  el.focus();
  const range = doc.createRange();
  range.selectNodeContents(el);
  const selection = win.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  return {
    cancel: () => {
      finish();
      restoreDom();
    },
  };
}

export { beginInlineEdit, canInlineEditClaim };
export type { InlineEditCallbacks, InlineEditHandle };
