/**
 * Pure helpers for aggregating adapter-contributed context dimensions and tabs
 * into the runtime's namespaced views. Kept free of any virtual-module imports
 * so it can be unit-tested in isolation.
 *
 * Every adapter dimension/tab id is namespaced as `"<adapter.name>:<id>"` to
 * avoid collisions when several adapters expose an id like `locale` or `tenant`.
 */

import type {
  AdapterTab,
  ContextDimension,
  ContextState,
} from "@designbookapp/designbook/config";

/** A dimension carrying its namespaced id and the adapter that owns it. */
type NamespacedDimension = ContextDimension & { adapterName: string };

/** A tab carrying its namespaced id and the adapter that owns it. */
type NamespacedTab = AdapterTab & { adapterName: string };

/** What each adapter contributes, keyed for aggregation. */
type AdapterContribution = {
  name: string;
  dimensions?: ContextDimension[];
  tabs?: AdapterTab[];
};

/** `"<adapter>:<id>"`. */
function namespaceId(adapterName: string, id: string): string {
  return `${adapterName}:${id}`;
}

function aggregateDimensions(
  contributions: AdapterContribution[],
): NamespacedDimension[] {
  const out: NamespacedDimension[] = [];
  for (const { name, dimensions } of contributions) {
    for (const dimension of dimensions ?? []) {
      out.push({
        ...dimension,
        id: namespaceId(name, dimension.id),
        adapterName: name,
      });
    }
  }
  return out;
}

function aggregateTabs(
  contributions: AdapterContribution[],
): NamespacedTab[] {
  const out: NamespacedTab[] = [];
  for (const { name, tabs } of contributions) {
    for (const tab of tabs ?? []) {
      out.push({ ...tab, id: namespaceId(name, tab.id), adapterName: name });
    }
  }
  return out;
}

/**
 * Builds the initial context from each dimension's `defaultValue`, overlaid by
 * any persisted value present for that (namespaced) dimension id.
 */
function initialContext(
  dimensions: NamespacedDimension[],
  persisted: Record<string, string> = {},
): ContextState {
  const state: ContextState = {};
  for (const dimension of dimensions) {
    const stored = persisted[dimension.id];
    state[dimension.id] =
      typeof stored === "string" ? stored : dimension.defaultValue;
  }
  return state;
}

export {
  aggregateDimensions,
  aggregateTabs,
  initialContext,
  namespaceId,
};
export type { AdapterContribution, NamespacedDimension, NamespacedTab };
