/**
 * Pure code-target attribution for an interleaved hit-test chain.
 *
 * A chain level's code target names the JSX usage site to highlight: the
 * *owner* component's file (the component whose render created the element —
 * from `_debugOwner`, see fibers.ts) plus the element's JSX name/className.
 *
 * Presence encodes drilled-ness structurally: the OUTERMOST chain level never
 * gets a code target (a fresh click selects it and shows the component's own
 * definition), while every deeper level always does (it can only be selected
 * by drilling, and must highlight its usage line in the owner's file). This
 * keeps the code panel's behavior a function of the selected hit alone — no
 * separate "am I drilled?" state to fall out of sync with.
 */

import type { CanvasCodeTarget } from "@designbook-ui/types";
import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";

type AttributableLink = {
  kind: "component" | "dom";
  /** Registry entry — component levels only. */
  entry?: RegistryEntry;
  /** Owner resolved from `_debugOwner` (may be absent, e.g. prod builds). */
  ownerEntry?: RegistryEntry;
  /** JSX name: component name (`Card`) or dom tag (`div`). */
  name: string;
  className?: string;
};

/** Nearest registered component *ancestor* (higher index) of `chain[index]`. */
function nearestComponentAncestor(
  chain: AttributableLink[],
  index: number,
): RegistryEntry | undefined {
  for (let j = index + 1; j < chain.length; j++) {
    const candidate = chain[j];
    if (candidate.kind === "component" && candidate.entry) {
      return candidate.entry;
    }
  }
  return undefined;
}

/** The component a level belongs to for labels/chat/"Go to component": its
 * creating owner, falling back to the nearest registered chain ancestor. */
function resolveLevelOwner(
  chain: AttributableLink[],
  index: number,
): RegistryEntry | undefined {
  return chain[index].ownerEntry ?? nearestComponentAncestor(chain, index);
}

/**
 * Code targets for every chain level (innermost → outermost, same order as
 * `chain`). The outermost level — and any level with no resolvable owner —
 * yields `undefined` (definition highlight).
 */
function resolveCodeTargets(
  chain: AttributableLink[],
): (CanvasCodeTarget | undefined)[] {
  return chain.map((link, index) => {
    if (index === chain.length - 1) return undefined;
    const owner = resolveLevelOwner(chain, index);
    if (!owner || !owner.sourcePath) return undefined;
    return {
      file: owner.sourcePath,
      ownerExportName: owner.key,
      name: link.name,
      kind: link.kind,
      className: link.className,
    };
  });
}

export { nearestComponentAncestor, resolveCodeTargets, resolveLevelOwner };
export type { AttributableLink };
