/**
 * Sidecar copy of the vite plugin's auto export index (config-slim spec).
 *
 * The plugin process owns the truth (it sees every transform); this store is
 * the sidecar's mirror, fed by full-snapshot POSTs to `/api/export-index`:
 *   - GET /api/export-index → the workbench synthesizes registry entries;
 *   - `lookupExportFiles(name)` → the sandbox export-scan ladder
 *     (makeExportResolver) checks the index BEFORE its bounded directory scan.
 *
 * Memory-only by design: an empty store just means every consumer falls back
 * to its pre-index behavior (name-based scan ladder), so a sidecar restart is
 * self-healing — the plugin re-pushes on its cadence.
 */

import type { ExportIndexFiles } from "../plugin/exportIndex.ts";

let files: ExportIndexFiles = {};
let version = 0;
/** New random value per sidecar process — lets the plugin detect restarts. */
const epoch = Math.random().toString(36).slice(2, 10);

let reverse: Map<string, string[]> | undefined;

/** Replace the index with a pushed snapshot. Returns the new version. */
function applyExportIndex(payload: unknown): number {
  const body = (payload ?? {}) as { files?: unknown };
  const next: ExportIndexFiles = {};
  if (body.files && typeof body.files === "object") {
    for (const [file, names] of Object.entries(body.files as Record<string, unknown>)) {
      if (typeof file !== "string" || !file || file.includes("..")) continue;
      if (!Array.isArray(names)) continue;
      const clean = names.filter(
        (name): name is string =>
          typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name),
      );
      if (clean.length > 0) next[file] = [...clean].sort();
    }
  }
  files = next;
  version += 1;
  reverse = undefined;
  return version;
}

function exportIndexSnapshot(): { version: number; epoch: string; files: ExportIndexFiles } {
  return { version, epoch, files };
}

/** Repo-relative files exporting `name`, sorted. Empty when unindexed. */
function lookupExportFiles(name: string): string[] {
  if (!reverse) {
    reverse = new Map();
    for (const [file, names] of Object.entries(files)) {
      for (const exported of names) {
        const list = reverse.get(exported);
        if (list) list.push(file);
        else reverse.set(exported, [file]);
      }
    }
    for (const list of reverse.values()) list.sort();
  }
  return reverse.get(name) ?? [];
}

/** Test seam: reset the singleton between cases. */
function resetExportIndexForTests(): void {
  files = {};
  version = 0;
  reverse = undefined;
}

export {
  applyExportIndex,
  exportIndexSnapshot,
  lookupExportFiles,
  resetExportIndexForTests,
};
