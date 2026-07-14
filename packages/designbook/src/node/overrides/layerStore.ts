/**
 * Changeset LAYER storage + resolution model
 * (docs/specs/changeset-layers.md, L1 — supersedes the shim/switch model of
 * docs/specs/sandbox-overrides.md).
 *
 * A changeset is a LAYER: a folder of alternative files stored at their full
 * repo-relative paths under `.designbook/changesets/<id>/alts/<altId>/…`, as
 * if rooted at the repo root. Active layers stack over the real tree —
 * topmost (highest `order`) wins per file — and the build host resolves any
 * request for a real file to the winning layer's SELECTED alternative via
 * the unchanged ModuleOverrideHost redirect table.
 *
 * This module owns the PURE layer model: paths, the meta.json shape +
 * parse/serialize, redirect-table computation, and file-level conflict
 * detection. All I/O lives in the orchestrator (src/node/api/sandbox.ts).
 * NOTHING here imports vite — enforced by overridesSeam.test.ts.
 */

/** Dir name of the layer home (sibling of `.designbook/sandbox`). The whole
 * dir is OUT of source control (gitignored / git-info-excluded): layers are
 * short-lived working state, dead after bake/discard. */
const CHANGESETS_DIRNAME = ".designbook/changesets";

/** Reserved subdir of the changesets home for the serve-time DATA-MERGE
 * artifacts (base + active layers' additions, regenerated on any flip).
 * Starts with `_` so it can never collide with a changeset id (ids are
 * `[a-z0-9-]`, see isValidIdSegment). */
const MERGED_DATA_DIRNAME = "_merged";

/** The altId a layer's DATA additions accumulate under (one merged data
 * alternative per layer per data file — additions, never full shadowing). */
const DATA_ALT_ID = "data";

/** One overridden repo path inside a layer: its alternatives + the live
 * SELECTION. No selection = the override is dormant (gallery-only; the real
 * file serves). Data files auto-select `DATA_ALT_ID` (additions merge
 * whenever the layer is active). */
type LayerOverride = {
  /** The altId currently served in place of the real file (code files), or
   * DATA_ALT_ID (data files). Absent = original serves. */
  selection?: string;
  alternatives: string[];
  /** DATA overrides only: leaf key paths this layer ADDED over its base
   * snapshot (badges, same-key conflict detection, bake merge). */
  addedKeys?: string[];
};

/**
 * One changeset layer's durable record (`meta.json` in its dir).
 * `branch`/`baseCommit` tag the layer to the branch it was created on:
 * entries from OTHER branches are tolerated on disk but HIDDEN from every
 * listing and never resolved (no cross-branch application in v1).
 */
type ChangesetLayer = {
  id: string;
  /** The pin thread that owns this exploration (1:1 in L1). L3: a
   * conversation's DIRECT-EDITS layer has no pin — pinId is "" and
   * `conversationId` names the owner instead. */
  pinId: string;
  title?: string;
  /** L3 — the conversation this changeset belongs to (pins created from a
   * conversation stamp it; direct-edits layers REQUIRE it). Absent =
   * legacy/ungrouped. */
  conversationId?: string;
  branch: string;
  baseCommit: string;
  createdAt: number;
  active: boolean;
  /** Stack position: higher = topmost; topmost active layer wins per file. */
  order: number;
  /** repo path → sha256 of the REAL file at capture (drift detection; code
   * files only — data merges against the current file by construction). */
  baseHashes: Record<string, string>;
  /** repo path → the layer's alternatives + selection. */
  overrides: Record<string, LayerOverride>;
  /** Compose parentage: the changeset ids this layer merged (the
   * `basedOnInactive` badge watches them). */
  bases?: string[];
  /** Drift flag (persisted so a restart keeps the warning). */
  drifted?: boolean;
  /** G2 reapply baseline: altId → the branch tip when its GENERATION landed
   * (variant fan-out / first trunk registration). Commits past this tip are
   * "post-selection edits" — the ones a variant switch offers to reapply.
   * Absent for pre-G2 layers (no reapply prompt, safe default). */
  generatedTips?: Record<string, string>;
  /** G3 bake-to-branch: the visible branch this changeset last baked to
   * (badge; re-bake targets it by default). The changeset stays ACTIVE. */
  bakedTo?: { branch: string; commit: string; at: number };
  /** G4 PARK (history explorer): a non-destructive preview pointer — the
   * projection serves `ref`'s state AS OF `commit` while NO ref moves.
   * Cleared on exit, on any ref-moving op, and consumed by an implicit
   * fork (new work while parked). `turn` = the sidecar turn label the
   * commit came from (banner copy), when known. */
  parked?: { commit: string; ref: string; turn?: string; at: number };
  /** G4 implicit forks, keyed by the fork's altId (`v/<altId>` ref):
   * where it was cut and — for conversation forks — the FORKED
   * conversation now bound to this changeset (its sliced chat). */
  forks?: Record<
    string,
    { forkCommit: string; fromTurn?: string; conversationId?: string; at: number }
  >;
  /** Display titles per ref (keyed by altId; the trunk uses its trunk
   * altId). `source` orders precedence: a USER rename is LOCKED (agent
   * `Title:` lines are ignored for that ref); "prompt" = the fork-creation
   * default (creating prompt, truncated); "agent" = a turn's optional
   * `Title:` line. Absent = the derived default (changeset/pin/variant
   * titles). */
  refTitles?: Record<
    string,
    { title: string; source: "user" | "agent" | "prompt"; at: number }
  >;
};

/** Repo-relative layer home for an app dir. */
function changesetsDir(appDir: string): string {
  return appDir ? `${appDir}/${CHANGESETS_DIRNAME}` : CHANGESETS_DIRNAME;
}

/** Repo-relative dir of one changeset layer. */
function changesetDir(appDir: string, changesetId: string): string {
  return `${changesetsDir(appDir)}/${changesetId}`;
}

/** Repo-relative path of a layer's durable meta record. */
function changesetMetaPath(appDir: string, changesetId: string): string {
  return `${changesetDir(appDir, changesetId)}/meta.json`;
}

/** The MIRRORED path of a repo file inside a layer: `appDir` prefixes are
 * stripped so the mirror stays inside the home that owns it (the same rule
 * the old shim mirror used). */
function mirroredPath(appDir: string, moduleRel: string): string {
  return appDir && moduleRel.startsWith(`${appDir}/`)
    ? moduleRel.slice(appDir.length + 1)
    : moduleRel;
}

/** Repo-relative path of one ALTERNATIVE file: the real file's repo-relative
 * path mirrored under `alts/<altId>/` — same path ⇒ relative imports,
 * aliases, and tailwind scanning just work; no re-pointing. */
function altFilePath(
  appDir: string,
  changesetId: string,
  altId: string,
  moduleRel: string,
): string {
  return `${changesetDir(appDir, changesetId)}/alts/${altId}/${mirroredPath(appDir, moduleRel)}`;
}

/** Repo-relative path of the BASE SNAPSHOT of an overridden file (captured
 * at first override; the 3-way merge input for drifted bakes and the
 * data-additions baseline). */
function baseFilePath(
  appDir: string,
  changesetId: string,
  moduleRel: string,
): string {
  return `${changesetDir(appDir, changesetId)}/base/${mirroredPath(appDir, moduleRel)}`;
}

/** Repo-relative path of the serve-time merged DATA artifact for a file. */
function mergedDataPath(appDir: string, moduleRel: string): string {
  return `${changesetsDir(appDir)}/${MERGED_DATA_DIRNAME}/${mirroredPath(appDir, moduleRel)}`;
}

/** Is `relPath` inside the layer home (guards pin targets/edits)? */
function isChangesetPath(relPath: string, appDir: string): boolean {
  return relPath.startsWith(`${changesetsDir(appDir)}/`);
}

/** Serialize a layer meta record (stable 2-space JSON + newline). */
function serializeLayerMeta(meta: ChangesetLayer): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

/** Revive one override record; wrong shapes are dropped/defaulted. */
function reviveOverride(raw: unknown): LayerOverride | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Partial<LayerOverride>;
  const alternatives = Array.isArray(record.alternatives)
    ? record.alternatives.filter(
        (alt): alt is string => typeof alt === "string" && alt.length > 0,
      )
    : [];
  return {
    alternatives,
    ...(typeof record.selection === "string" &&
    alternatives.includes(record.selection)
      ? { selection: record.selection }
      : {}),
    ...(Array.isArray(record.addedKeys)
      ? {
          addedKeys: record.addedKeys.filter(
            (key): key is string => typeof key === "string",
          ),
        }
      : {}),
  };
}

/** Parse a meta.json body. Undefined = unusable (skipped, never fatal). */
function parseLayerMeta(source: string): ChangesetLayer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Partial<ChangesetLayer>;
  if (typeof record.id !== "string" || !record.id) return undefined;
  // A layer is owned by a pin OR by a conversation (direct-edits, L3).
  const pinId = typeof record.pinId === "string" ? record.pinId : "";
  const conversationId =
    typeof record.conversationId === "string" && record.conversationId
      ? record.conversationId
      : undefined;
  if (!pinId && !conversationId) return undefined;
  const overrides: Record<string, LayerOverride> = {};
  if (record.overrides && typeof record.overrides === "object") {
    for (const [path, raw] of Object.entries(record.overrides)) {
      const revived = reviveOverride(raw);
      if (revived) overrides[path] = revived;
    }
  }
  return {
    id: record.id,
    pinId,
    ...(typeof record.title === "string" && record.title
      ? { title: record.title }
      : {}),
    ...(conversationId ? { conversationId } : {}),
    branch: typeof record.branch === "string" ? record.branch : "",
    baseCommit: typeof record.baseCommit === "string" ? record.baseCommit : "",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    active: record.active === true,
    order: typeof record.order === "number" ? record.order : 0,
    baseHashes:
      record.baseHashes && typeof record.baseHashes === "object"
        ? (record.baseHashes as Record<string, string>)
        : {},
    overrides,
    ...(Array.isArray(record.bases)
      ? {
          bases: record.bases.filter(
            (base): base is string => typeof base === "string",
          ),
        }
      : {}),
    ...(record.drifted === true ? { drifted: true } : {}),
    ...(record.generatedTips && typeof record.generatedTips === "object"
      ? {
          generatedTips: Object.fromEntries(
            Object.entries(record.generatedTips).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string" && entry[1].length > 0,
            ),
          ),
        }
      : {}),
    ...(record.bakedTo &&
    typeof record.bakedTo === "object" &&
    typeof record.bakedTo.branch === "string" &&
    record.bakedTo.branch &&
    typeof record.bakedTo.commit === "string"
      ? {
          bakedTo: {
            branch: record.bakedTo.branch,
            commit: record.bakedTo.commit,
            at: typeof record.bakedTo.at === "number" ? record.bakedTo.at : 0,
          },
        }
      : {}),
    ...(record.parked &&
    typeof record.parked === "object" &&
    typeof record.parked.commit === "string" &&
    record.parked.commit &&
    typeof record.parked.ref === "string" &&
    record.parked.ref
      ? {
          parked: {
            commit: record.parked.commit,
            ref: record.parked.ref,
            ...(typeof record.parked.turn === "string" && record.parked.turn
              ? { turn: record.parked.turn }
              : {}),
            at: typeof record.parked.at === "number" ? record.parked.at : 0,
          },
        }
      : {}),
    ...(record.forks && typeof record.forks === "object"
      ? {
          forks: Object.fromEntries(
            Object.entries(record.forks).flatMap(([altId, raw]) => {
              const fork = raw as {
                forkCommit?: unknown;
                fromTurn?: unknown;
                conversationId?: unknown;
                at?: unknown;
              } | null;
              if (
                !altId ||
                !fork ||
                typeof fork !== "object" ||
                typeof fork.forkCommit !== "string" ||
                !fork.forkCommit
              ) {
                return [];
              }
              return [
                [
                  altId,
                  {
                    forkCommit: fork.forkCommit,
                    ...(typeof fork.fromTurn === "string" && fork.fromTurn
                      ? { fromTurn: fork.fromTurn }
                      : {}),
                    ...(typeof fork.conversationId === "string" &&
                    fork.conversationId
                      ? { conversationId: fork.conversationId }
                      : {}),
                    at: typeof fork.at === "number" ? fork.at : 0,
                  },
                ],
              ];
            }),
          ),
        }
      : {}),
    ...(record.refTitles && typeof record.refTitles === "object"
      ? {
          refTitles: Object.fromEntries(
            Object.entries(record.refTitles).flatMap(([altId, raw]) => {
              const entry = raw as {
                title?: unknown;
                source?: unknown;
                at?: unknown;
              } | null;
              if (
                !altId ||
                !entry ||
                typeof entry !== "object" ||
                typeof entry.title !== "string" ||
                !entry.title ||
                (entry.source !== "user" &&
                  entry.source !== "agent" &&
                  entry.source !== "prompt")
              ) {
                return [];
              }
              return [
                [
                  altId,
                  {
                    title: entry.title,
                    source: entry.source,
                    at: typeof entry.at === "number" ? entry.at : 0,
                  },
                ],
              ];
            }),
          ),
        }
      : {}),
  };
}

/** The layers VISIBLE on `branch`, bottom→top stack order (order asc, id as
 * the deterministic tiebreak). Foreign-branch layers are filtered out of
 * every listing and never resolved. */
function visibleLayers(
  layers: readonly ChangesetLayer[],
  branch: string,
): ChangesetLayer[] {
  return [...layers]
    .filter((layer) => layer.branch === branch)
    .sort((a, b) =>
      a.order === b.order
        ? a.id < b.id
          ? -1
          : 1
        : a.order - b.order,
    );
}

/** The ACTIVE stack on `branch`, bottom→top. */
function activeLayers(
  layers: readonly ChangesetLayer[],
  branch: string,
): ChangesetLayer[] {
  return visibleLayers(layers, branch).filter((layer) => layer.active);
}

/**
 * The CODE redirect table for a stack: repo path → the topmost active
 * layer's SELECTED alternative (repo-relative). Data files never redirect
 * here — they merge (serve-time data merge). Overrides without a selection
 * are dormant.
 */
function computeLayerRedirects(params: {
  layers: readonly ChangesetLayer[];
  branch: string;
  appDir: string;
  isDataPath: (path: string) => boolean;
}): Map<string, string> {
  const out = new Map<string, string>();
  for (const layer of activeLayers(params.layers, params.branch)) {
    for (const [path, override] of Object.entries(layer.overrides).sort()) {
      if (params.isDataPath(path)) continue;
      if (!override.selection) continue;
      if (!override.alternatives.includes(override.selection)) continue;
      // Bottom→top iteration: later (topmost) layers overwrite.
      out.set(
        path,
        altFilePath(params.appDir, layer.id, override.selection, path),
      );
    }
  }
  return out;
}

/** One file-level conflict: the same repo path overridden by ≥2 ACTIVE
 * layers (data files exempt — they merge). */
type LayerConflict = { file: string; changesetIds: string[] };

/** All file-level conflicts across the active stack (spec: surfaced at
 * activation AND as a live badge; choose = deactivate one; merge/rebase =
 * L2+). An override counts once it has landed alternatives — selection is
 * irrelevant (two explorations of one file conflict even before preview). */
function computeLayerConflicts(params: {
  layers: readonly ChangesetLayer[];
  branch: string;
  isDataPath: (path: string) => boolean;
}): LayerConflict[] {
  const byFile = new Map<string, string[]>();
  for (const layer of activeLayers(params.layers, params.branch)) {
    for (const [path, override] of Object.entries(layer.overrides)) {
      if (params.isDataPath(path)) continue;
      if (override.alternatives.length === 0) continue;
      const list = byFile.get(path) ?? [];
      if (!list.includes(layer.id)) list.push(layer.id);
      byFile.set(path, list);
    }
  }
  return [...byFile]
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([file, changesetIds]) => ({ file, changesetIds }));
}

export {
  CHANGESETS_DIRNAME,
  DATA_ALT_ID,
  MERGED_DATA_DIRNAME,
  activeLayers,
  altFilePath,
  baseFilePath,
  changesetDir,
  changesetMetaPath,
  changesetsDir,
  computeLayerConflicts,
  computeLayerRedirects,
  isChangesetPath,
  mergedDataPath,
  mirroredPath,
  parseLayerMeta,
  serializeLayerMeta,
  visibleLayers,
};
export type { ChangesetLayer, LayerConflict, LayerOverride };
