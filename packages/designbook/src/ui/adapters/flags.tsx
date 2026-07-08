/**
 * Feature-flags adapter: teaches the canvas to read + write per-tenant flag
 * values from a JSON source of truth. Contributes a `tenant` context dimension,
 * a `Flags` tab of editable fields, and a provider that feeds the active
 * tenant's flag map to a customer-supplied `<FlagsProvider tenant flags>`.
 *
 * The eager `import.meta.glob` source is a build-time snapshot, so the adapter
 * keeps a mutable in-memory copy and updates it on each save; edits persist via
 * `POST /api/json` (a surgical one-field write) against the tenant's file.
 */

import { createElement, type ComponentType, type ReactNode } from "react";
import type { Adapter, AdapterSetup, ContextState } from "@designbookapp/designbook/config";
import { apiUrl, repoPathFromGlobKey } from "@designbook-ui/designbook";
import { notifyFileWritten } from "@designbook-ui/fileWriteBus";
import { getAdapterRuntime } from "@designbook-ui/adapterRuntime";

type FlagControl = "toggle" | "select" | "text" | "number" | "color";

type FlagSpec = {
  label: string;
  control: FlagControl;
  /** For `control: "select"` — the allowed values. */
  options?: string[];
};

type FlagsProviderProps = {
  tenant: string;
  flags: Record<string, unknown>;
  children: ReactNode;
};

type FlagsAdapterOptions = {
  /** Adapter name + dimension namespace. Default "flags". */
  id?: string;
  /** Tab label. Default "Flags". */
  label?: string;
  /** Tab/side-rail icon name. Default "flag". */
  icon?: string;
  /** Customer provider fed `{ tenant, flags }` for the active tenant. */
  Provider: ComponentType<FlagsProviderProps>;
  /**
   * The flag source of truth. Either an `import.meta.glob` result (eager,
   * `import: "default"`) or a plain object. Single-file layout:
   * `{ acme: { newCheckout: true }, globex: { … } }` keyed by tenant.
   * Per-tenant layout: a glob of `acme.json`, `globex.json`, … each a flag map.
   */
  source: Record<string, unknown>;
  /** Write target (config-relative) for the single-file layout. */
  sourcePath?: string;
  /** Tenants offered in the selector. Default = top-level keys of `source`. */
  tenants?: { value: string; label: string }[];
  /** The flags to surface as editable fields, keyed by flag id. */
  flags: Record<string, FlagSpec>;
};

type FlagsByTenant = Record<string, Record<string, unknown>>;

type FlagsModel = {
  flagsByTenant: FlagsByTenant;
  /** Repo-relative `.json` write target for a tenant. */
  pathFor: (tenant: string) => string | undefined;
  /** Key path within that file, e.g. "acme.newCheckout" or "newCheckout". */
  keyPathFor: (tenant: string, flagId: string) => string;
};

function looksLikeGlob(source: Record<string, unknown>): boolean {
  const keys = Object.keys(source);
  return keys.length > 0 && keys.every((key) => key.endsWith(".json"));
}

function fileStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.json$/, "");
}

/** Single JSON file keyed by tenant → `{ tenant: { flag: value } }`. */
function singleFileModel(rawPath: string, tenantsMap: unknown): FlagsModel {
  const flagsByTenant: FlagsByTenant = {};
  for (const [tenant, flags] of Object.entries(
    (tenantsMap as FlagsByTenant) ?? {},
  )) {
    flagsByTenant[tenant] = { ...(flags as Record<string, unknown>) };
  }
  return {
    flagsByTenant,
    // Resolved lazily: `repoPathFromGlobKey` reads the config dir, which may
    // still be in its module init cycle when the adapter is constructed.
    pathFor: () => repoPathFromGlobKey(rawPath),
    keyPathFor: (tenant, flagId) => `${tenant}.${flagId}`,
  };
}

function buildModel(
  source: Record<string, unknown>,
  sourcePath?: string,
): FlagsModel {
  if (looksLikeGlob(source)) {
    const entries = Object.entries(source);
    if (entries.length === 1) {
      const [path, tenantsMap] = entries[0];
      return singleFileModel(sourcePath ?? path, tenantsMap);
    }
    // Per-tenant files: one flag map per file, tenant = filename stem.
    const flagsByTenant: FlagsByTenant = {};
    const rawPathByTenant: Record<string, string> = {};
    for (const [path, flags] of entries) {
      const tenant = fileStem(path);
      flagsByTenant[tenant] = { ...(flags as Record<string, unknown>) };
      rawPathByTenant[tenant] = path;
    }
    return {
      flagsByTenant,
      pathFor: (tenant) =>
        rawPathByTenant[tenant]
          ? repoPathFromGlobKey(rawPathByTenant[tenant])
          : undefined,
      keyPathFor: (_tenant, flagId) => flagId,
    };
  }
  // Plain object keyed by tenant.
  return singleFileModel(sourcePath ?? "", source);
}

function normalizeValue(
  raw: unknown,
  control: FlagControl,
): string | boolean {
  if (control === "toggle") return Boolean(raw);
  if (raw === undefined || raw === null) return "";
  return typeof raw === "boolean" ? raw : String(raw);
}

/**
 * Creates a feature-flags adapter. Contributes a `tenant` dimension, a `Flags`
 * tab, and a provider around the canvas preview.
 */
function flagsAdapter(options: FlagsAdapterOptions): Adapter {
  const name = options.id ?? "flags";
  const label = options.label ?? "Flags";
  const icon = options.icon ?? "flag";
  const model = buildModel(options.source, options.sourcePath);
  const tenants =
    options.tenants ??
    Object.keys(model.flagsByTenant).map((key) => ({ value: key, label: key }));
  const tenantKey = `${name}:tenant`;
  const flagSpecs = options.flags;
  const Customer = options.Provider;

  function currentTenant(ctx: ContextState): string {
    return ctx[tenantKey] ?? tenants[0]?.value ?? "";
  }

  async function saveFlag(
    tenant: string,
    flagId: string,
    next: string | boolean,
  ): Promise<void> {
    const tenantFlags = model.flagsByTenant[tenant] ?? {};
    const had = Object.prototype.hasOwnProperty.call(tenantFlags, flagId);
    const previous = tenantFlags[flagId];

    // Optimistic: update the in-memory copy + re-render the preview provider.
    model.flagsByTenant[tenant] = { ...tenantFlags, [flagId]: next };
    getAdapterRuntime().notifyValuesChanged();

    const path = model.pathFor(tenant);
    if (!path) {
      // Roll back and fail — no write target for this tenant.
      rollback();
      throw new Error(`No write target configured for tenant "${tenant}".`);
    }

    try {
      const response = await fetch(apiUrl("/api/json"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path,
          keyPath: model.keyPathFor(tenant, flagId),
          value: next,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error ?? "Failed to save flag");
      }
      notifyFileWritten(path);
    } catch (error) {
      rollback();
      throw error instanceof Error
        ? error
        : new Error("Failed to save flag");
    }

    function rollback() {
      const current = { ...(model.flagsByTenant[tenant] ?? {}) };
      if (had) current[flagId] = previous;
      else delete current[flagId];
      model.flagsByTenant[tenant] = current;
      getAdapterRuntime().notifyValuesChanged();
    }
  }

  const FlagsCanvasProvider: AdapterSetup["Provider"] = ({
    context,
    values,
    children,
  }) => {
    const tenant = currentTenant(context);
    const flags =
      (values[name] as Record<string, unknown> | undefined) ??
      model.flagsByTenant[tenant] ??
      {};
    return createElement(Customer, { tenant, flags, children });
  };

  return {
    name,
    async setup(): Promise<AdapterSetup> {
      return {
        Provider: FlagsCanvasProvider,
        dimensions: [
          {
            id: "tenant",
            label: "Tenant",
            options: tenants,
            defaultValue: tenants[0]?.value ?? "",
          },
        ],
        tabs: [
          {
            id: "flags",
            label,
            icon,
            fields: (ctx) => {
              const tenant = currentTenant(ctx);
              const tenantFlags = model.flagsByTenant[tenant] ?? {};
              return Object.entries(flagSpecs).map(([flagId, spec]) => ({
                id: flagId,
                label: spec.label,
                control: spec.control,
                options: spec.options?.map((value) => ({
                  value,
                  label: value,
                })),
                value: normalizeValue(tenantFlags[flagId], spec.control),
                save: (next: string | boolean) =>
                  saveFlag(tenant, flagId, next),
              }));
            },
          },
        ],
        getValues: (ctx) => model.flagsByTenant[currentTenant(ctx)] ?? {},
      };
    },
  };
}

export { flagsAdapter };
export type { FlagsAdapterOptions, FlagsProviderProps, FlagSpec };
