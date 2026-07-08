/**
 * Pure host-context resolution (C4.3) — kept free of virtual-module imports so
 * it can be unit-tested in isolation (like `adapterAggregate`).
 *
 * A context dimension may declare a `hostContext` source (config-level getter
 * running in the app's realm). In INJECTED mode such a dimension "follows the
 * app": its effective value comes from `source.get()` until the designer picks
 * an explicit value in the canvas, which overrides it. The `FOLLOW_APP` sentinel
 * is the persisted pick value that means "following"; any other pick is an
 * explicit override. Host mode passes `injected = false`, which drops every
 * source so `hostContext` is ignored entirely.
 *
 * Resolution order for a host-context dimension: explicit pick > `source.get()`
 * > dimension default.
 */

import type { HostContextSource } from "@designbookapp/designbook/config";
import type { ContextState } from "@designbookapp/designbook/config";
import type { NamespacedDimension } from "./adapterAggregate";

/** Persisted pick value meaning "follow the app" for a host-context dimension. */
const FOLLOW_APP = "__db_follow_app__";

/** Per-dimension follow status surfaced to the switcher UI. */
type FollowState = {
  /** Whether the dimension is currently following the app value. */
  following: boolean;
  /** The app's current value (from `source.get()`), if any. */
  appValue?: string;
};

/**
 * Map each namespaced dimension to its host-context source, matched by the
 * dimension's LOCAL id (part after `<adapter>:`) or, for disambiguation, its
 * full namespaced id. Returns an empty map when not injected — host mode ignores
 * `hostContext`.
 */
function matchHostSources(
  dimensions: NamespacedDimension[],
  hostContext: Record<string, HostContextSource> | undefined,
  injected: boolean,
): Map<string, HostContextSource> {
  const map = new Map<string, HostContextSource>();
  if (!injected || !hostContext) return map;
  for (const dimension of dimensions) {
    const colon = dimension.id.indexOf(":");
    const localId = colon === -1 ? dimension.id : dimension.id.slice(colon + 1);
    const source = hostContext[dimension.id] ?? hostContext[localId];
    if (source) map.set(dimension.id, source);
  }
  return map;
}

/**
 * Initial pick state: persisted value wins; otherwise a host-context dimension
 * starts in FOLLOW mode and a plain dimension starts at its default.
 */
function initialPickState(
  dimensions: NamespacedDimension[],
  persisted: Record<string, string>,
  sources: Map<string, HostContextSource>,
): ContextState {
  const state: ContextState = {};
  for (const dimension of dimensions) {
    const stored = persisted[dimension.id];
    if (typeof stored === "string") {
      state[dimension.id] = stored;
    } else {
      state[dimension.id] = sources.has(dimension.id)
        ? FOLLOW_APP
        : dimension.defaultValue;
    }
  }
  return state;
}

/**
 * Resolve the effective context the canvas sees from the raw pick state,
 * reading `source.get()` for any dimension currently following the app. Also
 * returns the per-dimension follow status for the switcher UI.
 */
function resolveEffective(
  dimensions: NamespacedDimension[],
  pickState: ContextState,
  sources: Map<string, HostContextSource>,
): { context: ContextState; follow: Record<string, FollowState> } {
  const context: ContextState = {};
  const follow: Record<string, FollowState> = {};
  for (const dimension of dimensions) {
    const source = sources.get(dimension.id);
    const pick = pickState[dimension.id];
    if (source) {
      const following = pick === FOLLOW_APP;
      let appValue: string | undefined;
      try {
        appValue = source.get();
      } catch {
        appValue = undefined;
      }
      follow[dimension.id] = { following, appValue };
      context[dimension.id] = following
        ? (appValue ?? dimension.defaultValue)
        : (pick ?? dimension.defaultValue);
    } else {
      context[dimension.id] = pick ?? dimension.defaultValue;
    }
  }
  return { context, follow };
}

/** Shallow-equal two context maps (same keys assumed). */
function contextEquals(a: ContextState, b: ContextState): boolean {
  if (a === b) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export {
  FOLLOW_APP,
  contextEquals,
  initialPickState,
  matchHostSources,
  resolveEffective,
};
export type { FollowState };
