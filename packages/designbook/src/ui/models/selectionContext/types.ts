/**
 * Internal selection-context types (PREVIEW — docs/specs/selection-context.md).
 *
 * The PUBLIC contributor seam (`@designbookapp/designbook/config`) takes only
 * `(sel, { apiUrl })`. Internally the runner hands built-in contributors a
 * richer input: the full `CanvasNodeSelection` plus a LIVE HANDLE snapshot
 * (entry/instance ids, the live fiber/anchor from the canvas hit) and the
 * changed-files list captured at run time. Fiber access still goes only
 * through the previewHost seam — the handle is opaque (`unknown`) here.
 */

import type {
  SelectionContextContribution,
  SelectionContextFact,
  SelectionContextRunCtx,
} from "@designbookapp/designbook/config";
import type { CanvasNodeSelection } from "@designbook-ui/types";
import type { FileChange } from "@designbook-ui/models/branch/changesModel";

/** Transient live-canvas snapshot for the selection (never persisted). */
type SelectionLiveHandle = {
  /** Registry entry id of the hit component. */
  entryId?: string;
  /** Stable per-instance id (see previewHost getInstanceId). */
  instanceId?: string;
  /** Live fiber of a component hit — opaque outside the previewHost seam. */
  fiber?: unknown;
  /** Live anchor DOM element of the hit. */
  anchor?: Element;
};

/** What the runner captures when a selection-context run starts. */
type SelectionContextInput = {
  node: CanvasNodeSelection;
  live?: SelectionLiveHandle;
  /** Changed-files snapshot at run time (changes model — no re-fetch). */
  changes?: FileChange[];
};

/** Internal contributor shape (built-ins). Public contributors are adapted. */
type RegisteredSelectionContributor = (
  input: SelectionContextInput,
  ctx: SelectionContextRunCtx,
) =>
  | SelectionContextContribution
  | undefined
  | Promise<SelectionContextContribution | undefined>;

export type {
  RegisteredSelectionContributor,
  SelectionContextContribution,
  SelectionContextFact,
  SelectionContextInput,
  SelectionContextRunCtx,
  SelectionLiveHandle,
};
