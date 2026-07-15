/**
 * Registry machinery for the workbench canvas. All configuration comes from
 * the user's designbook config — this module only flattens the component sets
 * into entries, infers source paths, and builds the lookup maps used by fiber
 * hit-testing.
 *
 * Source paths are inferred by matching component references against the
 * config's `sourceModules` (an eager `import.meta.glob` over the repo's
 * component directories), so they survive file renames.
 */

import { lazy, type ComponentType } from "react";
import {
  apiUrl,
  repoPathFromGlobKey,
  sets,
  sourceModules,
} from "@designbook-ui/designbook";
import { readLazyMeta } from "@designbookapp/designbook/config";
import type {
  ComponentSet,
  EditableProp,
  MatrixAxis,
} from "@designbookapp/designbook/config";

type RegistryEntry = {
  id: string;
  /** Short name within the set, e.g. "Detail section". */
  name: string;
  /** Full label, e.g. "Ship · Detail section". */
  label: string;
  sourcePath: string;
  /**
   * The static component for eager entries. `undefined` for lazy entries — use
   * `makeLazyComponent(entry)` to materialize a React.lazy for rendering.
   */
  component: unknown;
  /** Dynamic-import thunk for lazy entries (a raw or `fromGlob`-branded glob thunk). */
  load?: () => Promise<unknown>;
  /** Forces which module export renders (from `overrides[key].exportName`). */
  exportName?: string;
  setId: string;
  key: string;
  editableProps?: EditableProp[];
  matrixAxes?: MatrixAxis[];
  previewWidth?: number;
  /** "index" for entries synthesized from the auto export index (config-slim);
   * absent for config-`sets` entries. Index entries are name-only (no ref). */
  origin?: "index";
  /** All repo files exporting this name (index entries only, sorted). The
   * first is `sourcePath`; the node-side ladder re-verifies on pin/edit. */
  sourceCandidates?: string[];
};

/** A value renderable as a React element type (function, memo/forwardRef, lazy). */
function isRenderableType(value: unknown): value is ComponentType {
  if (typeof value === "function") return true;
  return Boolean(value) && typeof value === "object" && "$$typeof" in (value as object);
}

/**
 * Classify a `components` value as a lazy source. Branded thunks (from
 * `fromGlob`/`lazy()`) are authoritative; a raw, zero-arg `() => import(...)`
 * thunk is sniffed by its source so a manual `import.meta.glob` entry works too.
 */
function asLazySource(
  value: unknown,
): { load: () => Promise<unknown>; globKey?: string; exportName?: string } | undefined {
  const meta = readLazyMeta(value);
  if (meta) {
    return {
      load: value as () => Promise<unknown>,
      globKey: meta.globKey,
      exportName: meta.exportName,
    };
  }
  if (typeof value === "function" && (value as (...a: unknown[]) => unknown).length === 0) {
    const src = Function.prototype.toString.call(value);
    if (/=>\s*import\s*\(|\breturn\s+import\s*\(/.test(src)) {
      return { load: value as () => Promise<unknown> };
    }
  }
  return undefined;
}

/**
 * Pick the component export from a loaded module for an entry. Order: an
 * explicit `exportName`, then the export matching the entry key, then the
 * default export, then the module's sole renderable export. Throws a readable
 * error when none resolves (surfaced in the cell's red error boundary).
 */
function resolveComponentExport(
  mod: unknown,
  key: string,
  exportName?: string,
): ComponentType {
  const record = (mod ?? {}) as Record<string, unknown>;
  if (exportName) {
    const picked = record[exportName];
    if (isRenderableType(picked)) return picked;
    throw new Error(
      `designbook: export "${exportName}" is not a component in the module for "${key}".`,
    );
  }
  if (isRenderableType(record[key])) return record[key] as ComponentType;
  if (isRenderableType(record.default)) return record.default as ComponentType;
  const candidates = Object.values(record).filter(isRenderableType);
  if (candidates.length === 1) return candidates[0];
  throw new Error(
    `designbook: could not resolve a component export for "${key}" ` +
      `(${candidates.length} candidate exports; set overrides.${key}.exportName).`,
  );
}

function buildSourcePathMap(): Map<unknown, string> {
  const map = new Map<unknown, string>();
  for (const [globKey, mod] of Object.entries(sourceModules)) {
    const repoPath = repoPathFromGlobKey(globKey);
    for (const exported of Object.values(mod as Record<string, unknown>)) {
      if (typeof exported === "function" && !map.has(exported)) {
        map.set(exported, repoPath);
      }
    }
  }
  return map;
}

const sourcePathByComponent = buildSourcePathMap();

function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function pascalCase(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function entryName(set: ComponentSet, key: string): string {
  const prefix = pascalCase(set.id);
  const short =
    key.startsWith(prefix) && key.length > prefix.length
      ? key.slice(prefix.length)
      : key;
  return humanize(short);
}

/** Returns the last `/`-delimited segment of a set title (e.g. "Ship" from "Cruises/Ship"). */
function setTitleLeaf(title: string): string {
  const segments = title.split("/");
  return segments[segments.length - 1];
}

function buildRegistry(): RegistryEntry[] {
  return sets.flatMap((set) =>
    Object.entries(set.components).flatMap(([key, value]): RegistryEntry[] => {
      const override = set.overrides?.[key];
      const lazySource = asLazySource(value);
      if (!lazySource && !isRenderableType(value)) return [];

      const name = entryName(set, key);
      const base = {
        id: `${set.id}.${key}`,
        name,
        label: `${setTitleLeaf(set.title)} · ${name}`,
        setId: set.id,
        key,
      };

      if (lazySource) {
        // Glob key IS the source path (C4.2) — no `sourceModules` needed.
        const globSourcePath = lazySource.globKey
          ? repoPathFromGlobKey(lazySource.globKey)
          : "";
        return [
          {
            ...base,
            component: undefined,
            load: lazySource.load,
            exportName: lazySource.exportName,
            sourcePath: globSourcePath,
            ...override,
          },
        ];
      }

      return [
        {
          ...base,
          component: value,
          sourcePath: sourcePathByComponent.get(value) ?? "",
          ...override,
        },
      ];
    }),
  );
}

const registry = buildRegistry();

const registryByRef = new Map<unknown, RegistryEntry>();
const registryByName = new Map<string, RegistryEntry>();

/**
 * Map a resolved component back to its entry for fiber hit-testing. Static
 * entries are indexed at build time; lazy entries call this from their
 * React.lazy factory once the real component has loaded (watch-out: fibers see
 * the resolved component, not the React.lazy wrapper).
 */
function registerResolvedComponent(
  component: ComponentType,
  entry: RegistryEntry,
): void {
  if (!registryByRef.has(component)) registryByRef.set(component, entry);
  const name =
    (component as { displayName?: string }).displayName ||
    (component as { name?: string }).name;
  if (name && !registryByName.has(name)) registryByName.set(name, entry);
}

/**
 * Best-effort JSX name a lazy entry's component will render under, WITHOUT
 * loading the module: an explicit `exportName` override wins, else the entry
 * key (`resolveComponentExport` prefers the export matching the key, and glob
 * entries conventionally export a component of that name).
 */
function lazyEntryName(entry: RegistryEntry): string | undefined {
  return entry.exportName ?? entry.key ?? undefined;
}

for (const entry of registry) {
  if (entry.component === undefined) {
    // Eager NAME registration for lazy entries: page-mode hit-testing runs
    // over the LIVE app DOM, where a composite (e.g. the demo's ProductCard)
    // renders before any canvas cell ever imports its module — without a name
    // mapping the fiber walk resolves only its (statically registered) atoms.
    // Registering the predicted name up front gives the entry an identity for
    // `matchFiber`'s by-name fallback while the module itself STAYS lazy
    // (code-splitting intact; byRef still registers post-load).
    const name = lazyEntryName(entry);
    if (name && !registryByName.has(name)) registryByName.set(name, entry);
    continue; // lazy: registered by ref post-load
  }
  if (!registryByRef.has(entry.component)) {
    registryByRef.set(entry.component, entry);
  }
  if (isRenderableType(entry.component)) {
    registerResolvedComponent(entry.component as ComponentType, entry);
  }
}

/**
 * Materialize a React.lazy for a lazy entry. A FRESH wrapper is created per call
 * so a retry after a failed import (React.lazy caches rejections) re-runs the
 * import — an HMR fix then recovers. The factory resolves the export and
 * registers the loaded component for hit-testing.
 */
function makeLazyComponent(entry: RegistryEntry): ComponentType {
  const load = entry.load;
  if (!load) throw new Error(`designbook: entry "${entry.id}" is not lazy.`);
  return lazy(async () => {
    const mod = await load();
    const resolved = resolveComponentExport(mod, entry.key, entry.exportName);
    registerResolvedComponent(resolved, entry);
    return { default: resolved };
  });
}

// ---------------------------------------------------------------------------
// Auto export index (config-slim spec): registry entries WITHOUT config sets.
//
// The vite plugin indexes the client graph (repo file → exported component
// names); the workbench fetches the snapshot from the sidecar and synthesizes
// a name-keyed entry per exported component. `matchFiber`'s by-name fallback
// then treats every in-repo named component as a drillable boundary — the
// same mechanism lazy set entries already used, generalized to the whole app.
// Config-`sets` entries (deprecated but still honored this release) win on
// name collisions; index entries never carry a component ref (byRef is
// untouched).
// ---------------------------------------------------------------------------

type ExportIndexFiles = Record<string, string[]>;

/** Names currently registered from the index (for re-sync removal). */
const indexRegisteredNames = new Map<string, RegistryEntry>();

/** Synthesized entry id for an index-backed component. */
function indexEntryId(file: string, name: string): string {
  return `src:${file}#${name}`;
}

/**
 * (Re)build the index-backed slice of `registryByName` from a snapshot.
 * Deterministic: files sorted, first file wins `sourcePath`; a name exported
 * from several files keeps the full candidate list as SILENT fallback data.
 *
 * No ambiguity warning: with transform-time source stamping (sourceStamp.ts)
 * the runtime resolves each fiber to its EXACT definition file off
 * `fiber.type.__dbSource`, so genuinely-distinct same-name components (every
 * `index.tsx` wrapper pattern makes one) resolve precisely — the name-index
 * candidate list is only a fallback for unstamped (library) components and no
 * longer drives resolution, so a same-name collision is not a problem to warn
 * about.
 */
function applyExportIndexToRegistry(files: ExportIndexFiles): void {
  const byName = new Map<string, string[]>();
  for (const file of Object.keys(files).sort()) {
    const names = files[file];
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (typeof name !== "string" || !/^[A-Z]/.test(name)) continue;
      const list = byName.get(name);
      if (list) list.push(file);
      else byName.set(name, [file]);
    }
  }

  // Remove index entries whose name vanished from the snapshot.
  for (const [name, entry] of [...indexRegisteredNames]) {
    if (byName.has(name)) continue;
    indexRegisteredNames.delete(name);
    if (registryByName.get(name) === entry) registryByName.delete(name);
  }

  for (const [name, candidates] of byName) {
    const existing = registryByName.get(name);
    const previous = indexRegisteredNames.get(name);
    if (existing && existing !== previous) continue; // config sets win
    // Multiple candidates are legitimate (barrels, same-name twins) and resolve
    // exactly at runtime via the fiber stamp — keep the full list as silent
    // fallback data; `sourcePath` (first file) is only the display default for
    // an unstamped selection.
    const sourcePath = candidates[0];
    if (
      previous &&
      previous.sourcePath === sourcePath &&
      previous.sourceCandidates?.length === candidates.length
    ) {
      continue; // unchanged
    }
    const entry: RegistryEntry = {
      id: indexEntryId(sourcePath, name),
      name,
      label: name,
      sourcePath,
      component: undefined,
      setId: "src",
      key: name,
      exportName: name,
      origin: "index",
      sourceCandidates: candidates,
    };
    indexRegisteredNames.set(name, entry);
    registryByName.set(name, entry);
  }
}

let exportIndexVersion = -1;
let exportIndexSyncStarted = false;

/** One fetch+apply pass; version-gated so unchanged snapshots are free. */
async function syncExportIndexOnce(): Promise<void> {
  try {
    const response = await fetch(apiUrl("/api/export-index"));
    if (!response.ok) return;
    const payload = (await response.json()) as {
      version?: number;
      files?: ExportIndexFiles;
    };
    if (typeof payload.version !== "number" || !payload.files) return;
    if (payload.version === exportIndexVersion) return;
    exportIndexVersion = payload.version;
    applyExportIndexToRegistry(payload.files);
  } catch {
    // Sidecar unreachable — keep whatever we have; next poll retries.
  }
}

/**
 * Start the export-index poll (mount calls this once). The index grows lazily
 * as the app's vite transforms modules, so a short poll keeps late-loading
 * pages selectable; version gating makes the steady state a no-op.
 */
function startExportIndexSync(): void {
  if (exportIndexSyncStarted) return;
  exportIndexSyncStarted = true;
  void syncExportIndexOnce();
  const timer = setInterval(() => void syncExportIndexOnce(), 3000);
  (timer as { unref?: () => void }).unref?.();
}

function getRegistryEntry(id: string): RegistryEntry | undefined {
  return registry.find((entry) => entry.id === id);
}

function getSetEntries(setId: string): RegistryEntry[] {
  return registry.filter((entry) => entry.setId === setId);
}

function getSetWrapper(setId: string): ComponentSet["wrapper"] {
  return sets.find((set) => set.id === setId)?.wrapper;
}

export {
  applyExportIndexToRegistry,
  asLazySource,
  getRegistryEntry,
  getSetEntries,
  getSetWrapper,
  lazyEntryName,
  makeLazyComponent,
  registry,
  registryByName,
  registryByRef,
  resolveComponentExport,
  startExportIndexSync,
};
export type { EditableProp, MatrixAxis, RegistryEntry };
