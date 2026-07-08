/**
 * Page-side marker runtime for the live-page text tool (M spec, M2).
 *
 * The plugin's build transform rewrites the app's `t()` / `i18n._()` call sites
 * to `__dbMark(value, key)` (see `src/node/pageTextTransform.ts`). `__dbMark`
 * (the `virtual:designbook-mark` module) is a thin passthrough that calls
 * `window.__designbook.mark` — installed HERE, from the prebuilt workbench
 * bundle, so it registers into the SAME `markerTable` the canvas decoder
 * (`textHits` → `getMarkerEntry`) reads. That shared table is what lets ONE
 * decoder serve both the canvas (workbench i18next instance) and the live page
 * (the app's own instance).
 *
 * Marking is gated on `window.__designbook.textToolActive`: passthrough (zero
 * cost, no markers in the DOM) unless the tool is armed. Arming/disarming also
 * forces the app to re-render so strings re-resolve through the now-marking
 * `t()`; saved edits are pushed back into the app instance so the page updates
 * without a reload. Both the refresh and the instance default to the shared
 * default i18next singleton, overridable via `config.pageText`.
 */

import { config } from "@designbook-ui/designbook";
import {
  allocateMarker,
  containsMarkerChars,
  encodeMarker,
  setMarkingActive,
} from "@designbook-ui/models/text/i18nMarkers";

/** The slice of the app's i18n instance this module drives. */
type AppI18n = {
  language?: string;
  emit?: (event: string, ...args: unknown[]) => void;
  addResource?: (lng: string, ns: string, key: string, value: string) => void;
};

type DBGlobal = {
  textToolActive?: boolean;
  pageTextDefaultNs?: string;
  mark?: (value: unknown, key: unknown, ns?: unknown) => unknown;
  __dbMarkInstalled?: boolean;
};

function dbGlobal(): DBGlobal {
  const w = window as unknown as { __designbook?: DBGlobal };
  return (w.__designbook ??= {});
}

/**
 * Pure marking core (unit-tested). Appends an attribution marker to a string
 * value while `isActive()`, registering `{namespace, key}` in the shared marker
 * table. Namespace resolves as: explicit `ns` arg > a `"ns:key"` prefix on the
 * key > the configured default. Non-strings, empties, and `@meta` keys pass
 * through untouched.
 */
function createPageMark(opts: {
  isActive: () => boolean;
  defaultNs: () => string;
}): (value: unknown, key: unknown, ns?: unknown) => unknown {
  return function mark(value, key, ns) {
    if (!opts.isActive()) return value;
    if (typeof value !== "string" || value.length === 0) return value;
    // Already attributed: an app that renders through the workbench's shared
    // i18next instance gets its markers from the postProcessor, and `t()` runs
    // BEFORE this wrapper — so skip to avoid a redundant second marker. The
    // transform path still marks apps that render through their OWN instance
    // (separate react-i18next copy) or via Lingui, where no marker is present.
    if (containsMarkerChars(value)) return value;

    let namespace = typeof ns === "string" && ns ? ns : undefined;
    let baseKey = typeof key === "string" ? key : undefined;
    if (baseKey) {
      const colon = baseKey.indexOf(":");
      if (colon > -1) {
        namespace = baseKey.slice(0, colon);
        baseKey = baseKey.slice(colon + 1);
      }
    }
    if (!baseKey || baseKey.startsWith("@")) return value;
    if (!namespace) namespace = opts.defaultNs() || "translation";

    const index = allocateMarker({ namespace, key: baseKey, resolvedKey: baseKey });
    return value + encodeMarker(index);
  };
}

/**
 * Install `window.__designbook.mark` (idempotent) and refresh the default
 * namespace from config. Safe to call on every page-tools mount.
 */
function installPageMark(): void {
  const g = dbGlobal();
  g.pageTextDefaultNs = config.i18n?.defaultNamespace ?? g.pageTextDefaultNs;
  if (g.__dbMarkInstalled) return;
  g.__dbMarkInstalled = true;
  g.mark = createPageMark({
    isActive: () => Boolean(g.textToolActive),
    defaultNs: () => g.pageTextDefaultNs ?? "translation",
  });
}

/**
 * Arm/disarm live-page marking for the text tool. Drives BOTH attribution
 * paths in lockstep: `__dbMark` (the build-transform path, gated on
 * `textToolActive`) and the marker postProcessor (the shared-instance path,
 * gated on `markingActive`) — the live page may use either.
 */
function setTextToolActive(active: boolean): void {
  dbGlobal().textToolActive = active;
  setMarkingActive(active);
}

/**
 * Restore the default marking state when the page-tools layer closes: markers
 * OFF for the transform path but the postProcessor back ON (its canvas default),
 * so a subsequent canvas open still attributes text. Page tools and the canvas
 * are mutually exclusive in injected mode, so this hand-off is safe.
 */
function resetPageTextMarking(): void {
  dbGlobal().textToolActive = false;
  setMarkingActive(true);
}

/**
 * Every i18next instance the app might actually render through, deduped. Which
 * one it is depends on module resolution (externalized i18next/react-i18next can
 * end up as more than one copy across the app + workbench graphs), so rather than
 * guess, we drive them ALL — a refresh/edit is idempotent on the instances that
 * aren't the live one. Candidates, best-first:
 *   1. `config.pageText.i18n()` — an explicit override;
 *   2. react-i18next's `getI18n()` — the instance react-i18next is bound to
 *      (after the workbench's i18next adapter inits with `initReactI18next`, this
 *      is what a provider-less `useTranslation()` renders through);
 *   3. the shared default i18next singleton.
 */
async function getAppI18nCandidates(): Promise<AppI18n[]> {
  const seen = new Set<unknown>();
  const out: AppI18n[] = [];
  const add = (inst: AppI18n | undefined | null) => {
    if (inst && !seen.has(inst)) {
      seen.add(inst);
      out.push(inst);
    }
  };

  add(config.pageText?.i18n?.() as AppI18n | undefined);
  try {
    const rti = (await import("react-i18next")) as {
      getI18n?: () => AppI18n | undefined;
    };
    add(rti.getI18n?.());
  } catch {
    // react-i18next not installed.
  }
  try {
    const mod = (await import("i18next")) as { default?: AppI18n } & AppI18n;
    add(mod.default ?? mod);
  } catch {
    // i18next not installed.
  }
  return out;
}

/** The primary (best-guess) app i18n instance, for callers that need just one. */
async function getAppI18n(): Promise<AppI18n | undefined> {
  return (await getAppI18nCandidates())[0];
}

/**
 * Re-render the app so every `t()` re-runs (re-marking or un-marking per the tool
 * state). `config.pageText.refresh` overrides. Otherwise emit BOTH `languageChanged`
 * and `loaded` on every candidate instance — react-i18next binds to those events
 * (`bindI18n: "languageChanged loaded"`), so whichever instance the app renders
 * through repaints; the others no-op.
 */
async function refreshPageText(): Promise<void> {
  const custom = config.pageText?.refresh;
  if (custom) {
    custom();
    return;
  }
  for (const instance of await getAppI18nCandidates()) {
    instance.emit?.("languageChanged", instance.language ?? "");
    instance.emit?.("loaded", {});
  }
}

/**
 * Reflect a saved edit into the app's live instance(s) so the page updates
 * without a reload (the file write is HMR-suppressed): add each entry to the
 * active locale's catalog, then re-render.
 */
async function applyEditToApp(
  namespace: string,
  entries: Array<{ key: string; value: string }>,
): Promise<void> {
  const candidates = await getAppI18nCandidates();
  for (const instance of candidates) {
    if (!instance.addResource) continue;
    const locale = instance.language ?? "";
    for (const { key, value } of entries) {
      instance.addResource(locale, namespace, key, value);
    }
  }
  await refreshPageText();
}

export {
  applyEditToApp,
  createPageMark,
  getAppI18n,
  getAppI18nCandidates,
  installPageMark,
  refreshPageText,
  resetPageTextMarking,
  setTextToolActive,
};
export type { AppI18n };
