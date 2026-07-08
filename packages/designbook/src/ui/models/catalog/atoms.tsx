/**
 * `catalog` model atoms: the small, declarative pieces a workbench
 * screen or a canvas cell composes over a registry entry / flow / set. They are
 * intentionally thin — the catalog's real logic is data flattening + lookups
 * (componentRegistry.ts / flows.ts) — so these exist only so a cell can label an
 * entry or a flow screen without reaching into a screen, and so name/route
 * rendering has ONE home.
 *
 * `useCatalogModel` (re-exported from CatalogProvider) is the context hook the
 * screens use to reach the config slices + `navigate` action.
 */

import type { ComponentSet, Flow, FlowScreen } from "@designbookapp/designbook/config";
import type { RegistryEntry } from "./componentRegistry";
import { useCatalogModel } from "./CatalogProvider";

/** An entry's short name within its set, e.g. "Detail section". */
function EntryName({ entry }: { entry: RegistryEntry }) {
  return <>{entry.name}</>;
}

/** An entry's full label, e.g. "Ship · Detail section". */
function EntryLabel({ entry }: { entry: RegistryEntry }) {
  return <>{entry.label}</>;
}

/** A set's leaf title (last `/`-segment), e.g. "Ship" from "Cruises/Ship". */
function SetTitle({ set }: { set: ComponentSet }) {
  const segments = set.title.split("/");
  return <>{segments[segments.length - 1]}</>;
}

/** A flow screen's route target id (its registry id, else its own id). */
function ScreenRoute({ screen }: { screen: FlowScreen }) {
  return <>{screen.registryId ?? screen.id}</>;
}

/** The registry entry for an id from the provider (undefined if unknown). */
function useEntry(id: string): RegistryEntry | undefined {
  return useCatalogModel().getEntry(id);
}

/** Every flow on the provider (the fixture set in cells; live config otherwise). */
function useFlows(): Flow[] {
  return useCatalogModel().flows;
}

export {
  EntryLabel,
  EntryName,
  ScreenRoute,
  SetTitle,
  useCatalogModel,
  useEntry,
  useFlows,
};
