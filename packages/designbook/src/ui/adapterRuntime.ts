/**
 * Resolves the configured adapters into a single runtime the canvas uses.
 *
 * Adapters contribute three kinds of capability, all READ+WRITE over a source
 * of truth scoped by the active context:
 *   - context **dimensions** (locale, tenant, …) shown as canvas selectors;
 *   - editable-field **tabs** shown in the side rail;
 *   - a **provider** wrapped around the canvas preview, fed the live context +
 *     per-adapter resolved values.
 * Plus the legacy text chain: the first adapter to claim a text node wins.
 *
 * Dimension/tab ids are namespaced `"<adapter.name>:<id>"`. The context is a
 * flat map of namespaced id → value, persisted to localStorage so a reload
 * restores the designer's selections. `setContext` mutates the store, notifies
 * subscribers (via `useSyncExternalStore`), and calls the owning adapter's
 * `onContextChange`.
 *
 * Adapter order: an `i18nextAdapter(config.i18n)` is prepended when the config
 * sets `i18n` and lists no explicit i18next adapter; then the config's own
 * adapters; then the built-in `sourceLiteralAdapter` fallback.
 */

import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type {
  Adapter,
  AdapterSetup,
  ContextState,
  LanguageOption,
  TextClaim,
  TextNodeHit,
} from "@designbookapp/designbook/config";
import { config, routing } from "@designbook-ui/designbook";
import {
  aggregateDimensions,
  aggregateTabs,
  namespaceId,
  type AdapterContribution,
  type NamespacedDimension,
  type NamespacedTab,
} from "./adapterAggregate";
import {
  FOLLOW_APP,
  contextEquals,
  initialPickState,
  matchHostSources,
  resolveEffective,
  type FollowState,
} from "./hostContext";
import { sourceLiteralAdapter } from "./adapters/sourceLiteralAdapter";

type AdapterProvider = ComponentType<{
  context: ContextState;
  values: Record<string, unknown>;
  children: ReactNode;
}>;

/** Live view the canvas subscribes to: current context + resolved values. */
type AdapterSnapshot = {
  /** Effective context — host-context dimensions resolved to their live value. */
  context: ContextState;
  values: Record<string, unknown>;
  /** Per-dimension follow status (host-context dimensions only). */
  follow: Record<string, FollowState>;
};

type AdapterRuntime = {
  /** Providers (outermost first) to wrap around the canvas, fed live state. */
  providers: AdapterProvider[];
  /** Context selectors (namespaced ids) for the canvas settings bar. */
  dimensions: NamespacedDimension[];
  /** Editable-field tabs (namespaced ids) for the side rail. */
  tabs: NamespacedTab[];
  /** Subscribe to context/value changes; returns an unsubscribe fn. */
  subscribe: (listener: () => void) => () => void;
  /** Stable snapshot of the live context + values (for `useSyncExternalStore`). */
  getSnapshot: () => AdapterSnapshot;
  /**
   * Set a namespaced dimension value; persists + notifies + fires hooks. Pass
   * the `FOLLOW_APP` sentinel to return a host-context dimension to "follow app".
   */
  setContext: (id: string, value: string) => void;
  /** Sentinel for `setContext` meaning "return this dimension to follow-app". */
  followAppValue: string;
  /**
   * Re-read host-context sources and emit if any followed value changed. Called
   * by source `subscribe`s and by the switcher's poll fallback.
   */
  refreshHostContext: () => void;
  /**
   * True when some followed dimension has no `subscribe`, so the switcher should
   * poll `refreshHostContext` while it is open.
   */
  needsFollowPolling: boolean;
  /** Recompute values + notify (e.g. after an optimistic field edit). */
  notifyValuesChanged: () => void;
  // Back-compat locale API (driven by the `:locale` dimension, if any):
  languages: LanguageOption[];
  defaultLocale: string;
  hasLanguages: boolean;
  setLocale: (locale: string) => Promise<void>;
  /** Full async chain (used on click). First non-null claim wins. */
  resolveClaim: (hit: TextNodeHit) => Promise<TextClaim | null>;
  /** Synchronous, side-effect-free chain for the hover highlight. */
  previewClaim: (hit: TextNodeHit) => TextClaim | null;
};

async function buildAdapterChain(): Promise<Adapter[]> {
  const configured = config.adapters ?? [];
  const chain: Adapter[] = [];

  const hasI18next = configured.some((adapter) => adapter.name === "i18next");
  if (config.i18n && !hasI18next) {
    // Dynamic import so the i18next/react-i18next graph lands in its own chunk:
    // a config with no `i18n` field (and no explicit i18next adapter) never
    // evaluates it, so an app without i18next installed never fails to resolve
    // the externalized `i18next`/`react-i18next` imports.
    const { i18nextAdapter } = await import("./adapters/i18next");
    chain.push(i18nextAdapter(config.i18n));
  }

  chain.push(...configured);

  const hasSourceLiteral = configured.some(
    (adapter) => adapter.name === "sourceLiteral",
  );
  if (!hasSourceLiteral) {
    chain.push(sourceLiteralAdapter());
  }

  return chain;
}

/** Fills in DOM defaults a claim omitted from the hit it was resolved for. */
function normalizeClaim(claim: TextClaim, hit: TextNodeHit): TextClaim {
  return {
    ...claim,
    node: claim.node ?? hit.node ?? undefined,
    element: claim.element ?? hit.element,
    rect: claim.rect ?? hit.rect,
    label: claim.label ?? claim.key,
  };
}

function storageKey(): string {
  return `designbook:context:${config.title || "default"}`;
}

function readPersisted(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore corrupt/inaccessible storage
  }
  return {};
}

function writePersisted(state: ContextState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(state));
  } catch {
    // ignore quota/inaccessible storage
  }
}

/** Per-dimension change routing: which adapter owns it and how to notify. */
type DimensionHandler = {
  localId: string;
  onContextChange?: AdapterSetup["onContextChange"];
  setLocale?: AdapterSetup["setLocale"];
};

async function initAdapterRuntime(): Promise<AdapterRuntime> {
  const chain = await buildAdapterChain();

  type Entry = { adapter: Adapter; setup?: AdapterSetup };
  const entries: Entry[] = [];
  const providers: AdapterProvider[] = [];

  for (const adapter of chain) {
    const setup = (await adapter.setup?.()) ?? undefined;
    entries.push({ adapter, setup });
    if (setup?.Provider) providers.push(setup.Provider as AdapterProvider);
  }

  const contributions: AdapterContribution[] = [];
  const dimHandlers = new Map<string, DimensionHandler>();

  for (const { adapter, setup } of entries) {
    const dimensions = [...(setup?.dimensions ?? [])];

    // Back-compat: an adapter that still returns `languages`/`setLocale`
    // (old i18n shape) without a `locale` dimension gets one synthesized so
    // the settings bar keeps working.
    if (
      setup?.languages &&
      setup.languages.length > 0 &&
      !dimensions.some((dimension) => dimension.id === "locale")
    ) {
      dimensions.push({
        id: "locale",
        label: "Language",
        options: setup.languages.map((language) => ({
          value: language.id,
          label: language.label,
        })),
        defaultValue: setup.defaultLocale ?? setup.languages[0].id,
      });
    }

    contributions.push({
      name: adapter.name,
      dimensions,
      tabs: setup?.tabs ?? [],
    });

    for (const dimension of dimensions) {
      dimHandlers.set(namespaceId(adapter.name, dimension.id), {
        localId: dimension.id,
        onContextChange: setup?.onContextChange,
        setLocale: dimension.id === "locale" ? setup?.setLocale : undefined,
      });
    }
  }

  const dimensions = aggregateDimensions(contributions);
  const tabs = aggregateTabs(contributions);
  const valueGetters = entries
    .filter((entry) => typeof entry.setup?.getValues === "function")
    .map((entry) => ({
      name: entry.adapter.name,
      getValues: entry.setup!.getValues!,
    }));

  // Host-context sources (C4.3): active only in injected mode (`routing`
  // "memory"). `pickState` is the persisted raw state — either the FOLLOW_APP
  // sentinel or an explicit user pick; the effective context resolves followed
  // dimensions to their live app value.
  const injected = routing === "memory";
  const hostSources = matchHostSources(dimensions, config.hostContext, injected);
  let pickState = initialPickState(dimensions, readPersisted(), hostSources);

  function computeValues(ctx: ContextState): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const { name, getValues } of valueGetters) {
      values[name] = getValues(ctx);
    }
    return values;
  }

  function buildSnapshot(): AdapterSnapshot {
    const { context, follow } = resolveEffective(dimensions, pickState, hostSources);
    return { context, values: computeValues(context), follow };
  }

  let snapshot: AdapterSnapshot = buildSnapshot();
  const listeners = new Set<() => void>();

  function emit() {
    snapshot = buildSnapshot();
    for (const listener of listeners) listener();
  }

  function setContext(id: string, value: string) {
    pickState = { ...pickState, [id]: value };
    writePersisted(pickState);
    // Returning a host-context dimension to follow-app is a read-only switch:
    // don't push back to the app (the app IS the source of truth). Any other
    // value is an explicit pick, so fire the owning adapter's change hook.
    if (value !== FOLLOW_APP) {
      const handler = dimHandlers.get(id);
      if (handler) {
        if (handler.onContextChange) {
          void handler.onContextChange(handler.localId, value, snapshot.context);
        } else if (handler.setLocale) {
          void handler.setLocale(value);
        }
      }
    }
    emit();
  }

  function refreshHostContext() {
    const next = buildSnapshot();
    if (!contextEquals(next.context, snapshot.context)) {
      snapshot = next;
      for (const listener of listeners) listener();
    }
  }

  // Live updates: subscribe to every source that offers one. Cheap and always
  // on (singleton runtime); the switcher polls the rest while it is open.
  let needsFollowPolling = false;
  for (const source of hostSources.values()) {
    if (typeof source.subscribe === "function") {
      source.subscribe(refreshHostContext);
    } else {
      needsFollowPolling = true;
    }
  }

  const localeDimension = dimensions.find((dimension) =>
    dimension.id.endsWith(":locale"),
  );
  const languages: LanguageOption[] = localeDimension
    ? localeDimension.options.map((option) => ({
        id: option.value,
        label: option.label,
      }))
    : [];
  const defaultLocale = localeDimension?.defaultValue ?? "en-US";

  return {
    providers,
    dimensions,
    tabs,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    setContext,
    followAppValue: FOLLOW_APP,
    refreshHostContext,
    needsFollowPolling,
    notifyValuesChanged: emit,
    languages,
    defaultLocale,
    hasLanguages: languages.length > 0,
    async setLocale(locale) {
      if (localeDimension) setContext(localeDimension.id, locale);
    },
    async resolveClaim(hit) {
      for (const adapter of chain) {
        const claim = await adapter.resolveText?.(hit);
        if (claim) return normalizeClaim(claim, hit);
      }
      return null;
    },
    previewClaim(hit) {
      for (const adapter of chain) {
        const claim = adapter.previewText?.(hit);
        if (claim) return normalizeClaim(claim, hit);
      }
      return null;
    },
  };
}

/**
 * Theme tokens exposed for Figma push token-attribution. A theme adapter
 * registers (and re-registers on variant/mode change) the CSS custom
 * properties it owns plus their Figma variable names; the serializer probes
 * each `cssVar`'s computed value inside the canvas theme element to attribute
 * concrete colors/dimensions back to tokens. No source registered → pushes
 * still work, just without variable bindings.
 */
type FigmaTokenSource = {
  /** Figma variable collection the tokens live in, e.g. "designbook/theme". */
  collection: string;
  tokens: Array<{
    /** CSS custom property name WITHOUT the leading `--`. */
    cssVar: string;
    /** Figma variable name (token name through the adapter's NameMap). */
    figmaName: string;
    type: "color" | "dimension" | "number" | "string";
    /**
     * Raw CSS expression to probe INSTEAD of `var(--cssVar)` when the custom
     * property may not exist in the document — derived tokens like the
     * Tailwind radius scale (`calc(var(--radius) * 1.4)` lives in the
     * `@theme` block, which may be inlined away by the build).
     */
    cssValue?: string;
  }>;
};

let figmaTokenSource: FigmaTokenSource | undefined;

function setFigmaTokenSource(source: FigmaTokenSource | undefined): void {
  figmaTokenSource = source;
}

function getFigmaTokenSource(): FigmaTokenSource | undefined {
  return figmaTokenSource;
}

let runtime: AdapterRuntime | undefined;

async function loadAdapterRuntime(): Promise<AdapterRuntime> {
  runtime ??= await initAdapterRuntime();
  return runtime;
}

/** The initialized runtime. Throws if accessed before `loadAdapterRuntime()`. */
function getAdapterRuntime(): AdapterRuntime {
  if (!runtime) {
    throw new Error("Adapter runtime accessed before initialization.");
  }
  return runtime;
}

/** Subscribes a component to the live canvas context + resolved values. */
function useAdapterSnapshot(): AdapterSnapshot {
  const current = getAdapterRuntime();
  return useSyncExternalStore(
    current.subscribe,
    current.getSnapshot,
    current.getSnapshot,
  );
}

export {
  getAdapterRuntime,
  getFigmaTokenSource,
  loadAdapterRuntime,
  setFigmaTokenSource,
  useAdapterSnapshot,
};
export type { AdapterRuntime, AdapterSnapshot, FigmaTokenSource };
