/**
 * Selection-context contributor registry (PREVIEW — docs/specs/
 * selection-context.md). House registry pattern (see
 * integrations/tokenSources.ts): module-level map + register/unregister +
 * snapshot/subscribe. The per-selection RUN lifecycle lives in store.ts.
 *
 * Order is deterministic: the "core" contributor first, then registration
 * order (built-ins register at mount before integration/adapter init, so the
 * built-in sections lead). Re-registering an id replaces the contributor in
 * place (Map insertion order is preserved).
 */

import type { RegisteredSelectionContributor } from "./types";

type RegisteredEntry = {
  id: string;
  contributor: RegisteredSelectionContributor;
};

const contributors = new Map<string, RegisteredSelectionContributor>();
const listeners = new Set<() => void>();
let snapshot: RegisteredEntry[] = [];

function emit(): void {
  const entries = [...contributors.entries()].map(([id, contributor]) => ({
    id,
    contributor,
  }));
  // Core pinned first regardless of registration timing; everything else
  // keeps insertion order.
  snapshot = [
    ...entries.filter((entry) => entry.id === "core"),
    ...entries.filter((entry) => entry.id !== "core"),
  ];
  for (const listener of listeners) listener();
}

/** Register (or replace, by id) a contributor. */
function registerSelectionContributor(
  id: string,
  contributor: RegisteredSelectionContributor,
): void {
  contributors.set(id, contributor);
  emit();
}

function unregisterSelectionContributor(id: string): void {
  if (contributors.delete(id)) emit();
}

/** Stable-identity ordered contributor list (core first). */
function getSelectionContributors(): RegisteredEntry[] {
  return snapshot;
}

function subscribeSelectionContributors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: drop all registered contributors. */
function resetSelectionContributors(): void {
  contributors.clear();
  emit();
}

export {
  getSelectionContributors,
  registerSelectionContributor,
  resetSelectionContributors,
  subscribeSelectionContributors,
  unregisterSelectionContributor,
};
export type { RegisteredEntry };
