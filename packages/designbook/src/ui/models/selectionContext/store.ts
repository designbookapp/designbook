/**
 * The selection-context RUN store (PREVIEW — docs/specs/selection-context.md).
 *
 * Owns the per-selection lifecycle over the contributor registry:
 *   - `runSelectionContext(input, ctx)` — called by the Workbench when the
 *     canvas selection changes. Sync contributions land in the snapshot
 *     immediately; async ones patch in when they resolve (stale runs are
 *     dropped by run-id check). Contributors never subscribe to live stores —
 *     they snapshot at run time; a re-run is the only refresh.
 *   - `refreshSelectionContext()` — re-runs contributors for the current
 *     selection (the Info panel's manual refresh).
 *   - `getSelectionContextSnapshot()`/`subscribeSelectionContext()` — for
 *     `useSyncExternalStore` (Info panel + chat marker).
 *   - `getSelectionPromptFragments()` — the funnel's view: resolved prompt
 *     fragments in contributor order (core first), each capped to the
 *     per-contributor budget. Prompt assembly at send time takes whatever has
 *     resolved by then.
 */

import { getSelectionContributors } from "./registry";
import type {
  SelectionContextContribution,
  SelectionContextInput,
  SelectionContextRunCtx,
} from "./types";

/** Per-contributor prompt budget (chars) before truncation. */
const PROMPT_FRAGMENT_BUDGET = 700;
const TRUNCATION_MARKER = "\n[truncated]";

/** Cap one contributor's prompt fragment to the budget, with a marker. */
function capPromptFragment(
  fragment: string,
  budget: number = PROMPT_FRAGMENT_BUDGET,
): string {
  if (fragment.length <= budget) return fragment;
  return fragment.slice(0, budget) + TRUNCATION_MARKER;
}

type SelectionPromptFragment = { source: string; prompt: string };

type SelectionContextSnapshot = {
  /** The selection this snapshot describes; undefined = nothing selected. */
  input?: SelectionContextInput;
  /** Resolved contributions, contributor order (core first). */
  contributions: SelectionContextContribution[];
  /** Contributors still resolving (async). */
  pending: number;
};

const EMPTY: SelectionContextSnapshot = { contributions: [], pending: 0 };

let snapshot: SelectionContextSnapshot = EMPTY;
const listeners = new Set<() => void>();

let runId = 0;
let currentInput: SelectionContextInput | undefined;
let currentCtx: SelectionContextRunCtx | undefined;

function emit(): void {
  for (const listener of listeners) listener();
}

function isThenable(
  value: unknown,
): value is Promise<SelectionContextContribution | undefined> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Run every registered contributor against `input`. Pass `undefined` to clear
 * (nothing selected). Sync results are visible in the snapshot when this
 * returns; async ones patch in later.
 */
function runSelectionContext(
  input: SelectionContextInput | undefined,
  ctx: SelectionContextRunCtx,
): void {
  const id = ++runId;
  currentInput = input;
  currentCtx = ctx;

  if (!input) {
    snapshot = EMPTY;
    emit();
    return;
  }

  const entries = getSelectionContributors();
  // One slot per contributor keeps panel order stable as async slots fill in.
  const slots: (SelectionContextContribution | undefined)[] = new Array(
    entries.length,
  ).fill(undefined);
  let pending = 0;

  const publish = () => {
    if (id !== runId) return; // a newer run owns the snapshot
    snapshot = {
      input,
      contributions: slots.filter(
        (slot): slot is SelectionContextContribution => slot !== undefined,
      ),
      pending,
    };
    emit();
  };

  entries.forEach((entry, index) => {
    let result;
    try {
      result = entry.contributor(input, ctx);
    } catch {
      return; // a broken contributor never takes the panel down
    }
    if (isThenable(result)) {
      pending += 1;
      void result
        .then((contribution) => {
          slots[index] = contribution ?? undefined;
        })
        .catch(() => undefined)
        .then(() => {
          pending -= 1;
          publish();
        });
      return;
    }
    slots[index] = result ?? undefined;
  });

  publish();
}

/** Re-run all contributors for the current selection (manual refresh). */
function refreshSelectionContext(): void {
  if (!currentCtx) return;
  runSelectionContext(currentInput, currentCtx);
}

function getSelectionContextSnapshot(): SelectionContextSnapshot {
  return snapshot;
}

function subscribeSelectionContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolved prompt fragments in contributor order, budget-capped. */
function getSelectionPromptFragments(): SelectionPromptFragment[] {
  return snapshot.contributions.flatMap((contribution) =>
    contribution.prompt
      ? [
          {
            source: contribution.source,
            prompt: capPromptFragment(contribution.prompt),
          },
        ]
      : [],
  );
}

/**
 * The assembled context block for the outgoing prompt (and the expandable
 * chat marker): each resolved fragment under a `[source]` header. Undefined
 * when nothing has resolved (the funnel falls back to the legacy lines).
 */
function buildSelectionContextBlock(
  fragments: SelectionPromptFragment[] = getSelectionPromptFragments(),
): string | undefined {
  if (fragments.length === 0) return undefined;
  return fragments
    .map((fragment) => `[${fragment.source}]\n${fragment.prompt}`)
    .join("\n");
}

/** Test seam: clear the run state. */
function resetSelectionContext(): void {
  runId += 1;
  currentInput = undefined;
  currentCtx = undefined;
  snapshot = EMPTY;
  emit();
}

export {
  PROMPT_FRAGMENT_BUDGET,
  buildSelectionContextBlock,
  capPromptFragment,
  getSelectionContextSnapshot,
  getSelectionPromptFragments,
  refreshSelectionContext,
  resetSelectionContext,
  runSelectionContext,
  subscribeSelectionContext,
};
export type { SelectionContextSnapshot, SelectionPromptFragment };
