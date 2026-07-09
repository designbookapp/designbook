/**
 * The `variations` model — pure state for the design-variations review
 * (docs/specs/design-variations.md, DECIDED 2026-07-09).
 *
 * The server orchestrator broadcasts `variations-event`s over the existing
 * SSE channel as N parallel ephemeral sessions land candidate files in
 * `.designbook/variations/`. This module owns the PURE folds over those
 * events, the GET /api/variations → state mapping (reload reconstruction from
 * the durable index), and the synthesis of a `RegistryEntry`-shaped object
 * whose `load` dynamically imports the variant module via `/@fs/` — so
 * `PreviewCell` renders a landed variant exactly like any lazy entry
 * (set wrapper, Suspense, red-cell isolation), with NO reload anywhere.
 *
 * The stateful lifecycle (EventSource, fetches) lives in `useVariations`.
 */

import type { RegistryEntry } from "@designbook-ui/models/catalog/componentRegistry";

type VariationItemStatus = "generating" | "landed" | "failed" | "updating";

type VariationItem = {
  slug: string;
  intent: string;
  status: VariationItemStatus;
  /** Repo-relative variant path (present once landed). */
  path?: string;
  /** Absolute variant path — the /@fs/ module URL base (present once landed). */
  absPath?: string;
  /** Bumped per landing/update; cache-busts the dynamic import (?t=). */
  rev: number;
  error?: string;
};

type VariationSet = {
  base: string;
  baseSourcePath?: string;
  /** True between generate and the director's directions resolving. */
  planning: boolean;
  items: VariationItem[];
};

/** All pending sets, keyed by base entry id. */
type VariationsState = Record<string, VariationSet>;

type VariationsEvent = {
  kind?: string;
  base?: string;
  slug?: string;
  intent?: string;
  path?: string;
  absPath?: string;
  rev?: number;
  error?: string;
  action?: string;
  count?: number;
  items?: Array<{ slug?: string; intent?: string }>;
};

// ---------------------------------------------------------------------------
// Folds.
// ---------------------------------------------------------------------------

function upsertItem(
  set: VariationSet,
  slug: string,
  patch: Partial<VariationItem>,
): VariationSet {
  const exists = set.items.some((item) => item.slug === slug);
  const items = exists
    ? set.items.map((item) =>
        item.slug === slug ? { ...item, ...patch, slug } : item,
      )
    : [
        ...set.items,
        {
          slug,
          intent: "",
          status: "generating" as const,
          rev: 0,
          ...patch,
        },
      ];
  return { ...set, items };
}

/** Fold one `variations-event` into the state. Unknown kinds are no-ops. */
function applyVariationsEvent(
  state: VariationsState,
  event: VariationsEvent,
): VariationsState {
  const base = event.base;
  if (!base) return state;
  const set: VariationSet = state[base] ?? {
    base,
    planning: false,
    items: [],
  };

  switch (event.kind) {
    case "planning":
      return { ...state, [base]: { ...set, planning: true } };
    case "planned": {
      let next = { ...set, planning: false };
      for (const item of event.items ?? []) {
        if (!item.slug) continue;
        next = upsertItem(next, item.slug, {
          intent: item.intent ?? "",
          status: "generating",
          error: undefined,
        });
      }
      return { ...state, [base]: next };
    }
    case "landed":
      if (!event.slug) return state;
      return {
        ...state,
        [base]: upsertItem(set, event.slug, {
          status: "landed",
          intent: event.intent ?? undefined,
          path: event.path,
          absPath: event.absPath,
          rev: event.rev ?? 1,
          error: undefined,
        }),
      };
    case "failed":
      if (!event.slug) return state;
      return {
        ...state,
        [base]: upsertItem(set, event.slug, {
          status: "failed",
          // Expected target path — a failed cell shows WHERE the variant was
          // supposed to land alongside WHY it didn't.
          path: event.path ?? undefined,
          error: event.error ?? "Generation failed.",
        }),
      };
    case "updating":
      if (!event.slug) return state;
      return {
        ...state,
        [base]: upsertItem(set, event.slug, { status: "updating" }),
      };
    case "updated":
      if (!event.slug) return state;
      return {
        ...state,
        [base]: upsertItem(set, event.slug, {
          status: "landed",
          absPath: event.absPath ?? undefined,
          rev: event.rev ?? 1,
          error: undefined,
        }),
      };
    case "resolved": {
      if (event.action === "keep" || event.action === "abandon") {
        const { [base]: _gone, ...rest } = state;
        return rest;
      }
      // keepAs / discard remove one slug; drop the set when it empties.
      const items = set.items.filter((item) => item.slug !== event.slug);
      if (items.length === 0) {
        const { [base]: _gone, ...rest } = state;
        return rest;
      }
      return { ...state, [base]: { ...set, items } };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// GET /api/variations → state (reload reconstruction).
// ---------------------------------------------------------------------------

type StatusPayload = {
  sets?: Array<{
    base?: string;
    baseSourcePath?: string;
    planning?: boolean;
    items?: Array<{
      slug?: string;
      intent?: string;
      status?: string;
      sourcePath?: string;
      absPath?: string;
      rev?: number;
      error?: string;
    }>;
  }>;
};

const ITEM_STATUSES: VariationItemStatus[] = [
  "generating",
  "landed",
  "failed",
  "updating",
];

function setsFromStatus(payload: StatusPayload): VariationsState {
  const state: VariationsState = {};
  for (const raw of payload.sets ?? []) {
    if (!raw.base) continue;
    state[raw.base] = {
      base: raw.base,
      baseSourcePath: raw.baseSourcePath,
      planning: raw.planning === true,
      items: (raw.items ?? []).flatMap((item) => {
        if (!item.slug) return [];
        const status = ITEM_STATUSES.includes(
          item.status as VariationItemStatus,
        )
          ? (item.status as VariationItemStatus)
          : "generating";
        return [
          {
            slug: item.slug,
            intent: item.intent ?? "",
            status,
            path: item.sourcePath,
            absPath: item.absPath,
            rev: item.rev ?? 0,
            error: item.error,
          },
        ];
      }),
    };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Rendering: module URL + synthesized entry.
// ---------------------------------------------------------------------------

/**
 * Dev-server module URL for a variant file. `/@fs/` + absolute path works in
 * BOTH modes (host: embedded vite fs.allow includes the project root;
 * injected: their dev server allows the workspace). `?t=<rev>` cache-busts
 * re-imports after an iterate edit (probe-verified).
 */
function variantModuleUrl(absPath: string, rev: number): string {
  return `/@fs${absPath.startsWith("/") ? "" : "/"}${absPath}?t=${rev}`;
}

/**
 * A `RegistryEntry`-shaped object for a LANDED variant, rendering through the
 * standard `PreviewCell` path (set wrapper, lazy import, red-cell isolation).
 * `key` mirrors the BASE entry's key: the variant exports the same component
 * name as the original, so export resolution works unchanged.
 *
 * IDENTITY-STABLE: `PreviewCell` memoizes its `React.lazy` on the entry
 * OBJECT — a fresh object per render means a fresh lazy per render, which
 * re-suspends every parent re-render (React hides the old content with
 * `display:none`, the strip flickers fallback forever, and the empty-render
 * detector reads the hidden 0-height content — the live-verify feedback
 * loop). Same inputs → same cached object; the rev in the cache key retires
 * stale entries naturally after an iterate.
 */
const variantEntryCache = new Map<string, RegistryEntry>();

function synthesizeVariantEntry(
  base: RegistryEntry,
  item: VariationItem,
): RegistryEntry | undefined {
  if (item.status !== "landed" || !item.absPath) return undefined;
  const url = variantModuleUrl(item.absPath, item.rev);
  const cacheKey = `${base.setId}|${base.key}|variation/${base.id}/${item.slug}#${item.rev}|${item.absPath}`;
  const cached = variantEntryCache.get(cacheKey);
  if (cached) return cached;
  const entry: RegistryEntry = {
    id: `variation/${base.id}/${item.slug}#${item.rev}`,
    name: item.slug,
    label: `${base.label} · ${item.slug}`,
    sourcePath: item.path ?? "",
    component: undefined,
    load: () => import(/* @vite-ignore */ url),
    exportName: base.exportName,
    setId: base.setId,
    key: base.key,
  };
  variantEntryCache.set(cacheKey, entry);
  return entry;
}

/**
 * Classify a mounted variant preview's measured root box (layout size,
 * `offsetWidth`/`offsetHeight` — pre-transform, so canvas zoom is irrelevant).
 * "empty" = the component rendered but collapsed to (near) zero area — the
 * classic absolutely-positioned-hero-with-no-intrinsic-height failure. The
 * strip surfaces that with failed-cell prominence instead of presenting a
 * sliver as a normal variant. `undefined` (no `[data-db-entry]` root yet:
 * loading, red cell, or shadow-isolated teleport) stays "unknown" — never a
 * false positive.
 */
const EMPTY_RENDER_THRESHOLD_PX = 24;

function classifyRenderedSize(
  size: { width: number; height: number } | undefined,
  threshold: number = EMPTY_RENDER_THRESHOLD_PX,
): "unknown" | "empty" | "ok" {
  if (!size) return "unknown";
  return size.width < threshold || size.height < threshold ? "empty" : "ok";
}

/** `n of m landed` strip header state. */
function landedCounts(set: VariationSet): { landed: number; total: number } {
  return {
    landed: set.items.filter((item) => item.status === "landed").length,
    total: set.items.length,
  };
}

export {
  EMPTY_RENDER_THRESHOLD_PX,
  applyVariationsEvent,
  classifyRenderedSize,
  landedCounts,
  setsFromStatus,
  synthesizeVariantEntry,
  variantModuleUrl,
};
export type {
  StatusPayload,
  VariationItem,
  VariationItemStatus,
  VariationSet,
  VariationsEvent,
  VariationsState,
};
