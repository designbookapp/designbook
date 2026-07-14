/**
 * Vite implementation of the `ModuleOverrideHost` seam
 * (docs/specs/sandbox-overrides.md §Build-environment portability) — the
 * "~a screen of code" a build environment contributes. Everything override-
 * shaped (shim codegen, redirect diffing, bypass semantics, the dev-only
 * gate) lives in src/node/overrides/, vite-free; this file only adapts the
 * four host methods onto vite primitives:
 *
 *   redirect   → a map consulted from `resolveId` (after normal resolution
 *                via `this.resolve`, so aliases/tsconfig-paths still apply);
 *   bypass     → `?db-original` resolves the REAL module (loop-proof);
 *   invalidate → module-graph invalidation of the module + its importers;
 *   hotUpdate  → re-emit watcher `change` events for the invalidated
 *                importers — byte-for-byte the native js-update path (the
 *                generatedTailwindRefresh discipline), NEVER a full reload.
 *
 * Used by BOTH topologies: the injected plugin polls the sidecar's
 * `/api/sandbox/redirects` (separate process); host mode pushes the table
 * in-process (server.ts wires `onSandboxOverridesChanged` to the driver).
 * `apply: "serve"` keeps the whole plugin out of production builds — and the
 * controller's own dev-only gate holds even if a host were mis-wired.
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import {
  createOverrideHostDriver,
  hasBypassMarker,
  normalizeModulePath,
  ORIGINAL_BYPASS_QUERY,
  resolveOverrideRedirect,
  stripBypassMarker,
  type ModuleOverrideHost,
} from "../overrides/overrideController.ts";

/** Poll cadence for the injected topology's redirect fetch (matches the
 * recent-writes poll — first-time override latency ≤ ~1s). */
const REDIRECTS_POLL_MS = 1000;

type RedirectsPayload = {
  version?: number;
  redirects?: Record<string, string>;
  /** Per-real-path content stamps: a bump means the redirect TARGET's bytes
   * were re-projected in place (park/rollback/turn-end) — the driver treats
   * it as a value change and hot-updates deterministically. */
  stamps?: Record<string, number>;
};

type SandboxOverridesVite = {
  plugin: Plugin;
  /** Push a redirect table (host mode's in-process wiring). */
  apply: (
    redirects: Record<string, string>,
    stamps?: Record<string, number>,
  ) => void;
};

/** Content types the HTTP-data middleware serves. Deliberately json/po ONLY:
 * css data files are (in practice) module-imported entry css — vite's
 * transform pipeline serves them through the resolveId redirect, and
 * intercepting the URL here would hand the browser RAW tailwind source
 * (live-run finding: "[vite] Failed to reload /src/index.css"). */
const HTTP_DATA_CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".po": "text/plain; charset=utf-8",
};

/** Vite query markers that mean "module-graph request" — those flow to the
 * transform pipeline, where the resolveId redirect already applies. */
const VITE_MODULE_QUERY = /(?:^|[?&])(?:import|direct|raw|url|worker|inline)(?:[=&]|$)/;

/**
 * Build the vite override plugin + its push seam. Pass `fetchRedirects` for
 * the polled (injected/cross-process) topology; omit it and drive `apply`
 * directly for the in-process (host mode) topology.
 */
function createSandboxOverridesVite(options: {
  fetchRedirects?: () => Promise<RedirectsPayload | undefined>;
  /**
   * Importer files to invalidate SILENTLY (never hot-emit): the designbook
   * config imports registry components, carries react-refresh boilerplate
   * (isSelfAccepting), but its non-component exports make the client
   * invalidate on update — which bubbles into the boot module's dynamic
   * import and escalates to a FULL RELOAD (live-run finding). It is not part
   * of the rendered page tree, so a silent invalidation is always safe.
   */
  excludeHotFiles?: string[];
  /**
   * Generated-file dirs (abs) whose module writes must NEVER escalate to a
   * full reload. Root cause (live-run finding): @tailwindcss/vite's
   * hotUpdate sends a SILENT `full-reload` whenever a SCANNED file changes
   * whose module-graph entries are asset-only — exactly a landed sandbox
   * variant nothing imports yet — and vite core's own propagation dead-ends
   * ("page reload <file>") on an unreferenced module. Two layers:
   *
   *   1. GUARD (deterministic): a `hotUpdate` hook ordered `"pre"` — vite
   *      sorts hook-level order ABOVE plugin array position, so it runs
   *      before tailwind's regardless of where the app listed its plugins —
   *      swallows the update (returns `[]`) whenever the file has no
   *      REFERENCED JS module (unknown file, tailwind's asset-only entry, or
   *      a warmed-but-unimported module). Later hooks then see zero modules:
   *      tailwind's `modules.length > 0` gate bails, and vite core logs "no
   *      modules matched" instead of reloading. Utility freshness is owned
   *      by generatedTailwindRefresh (entry-css re-emit), which listens to
   *      the watcher directly and is untouched by the swallow.
   *   2. WARM (fast path): `server.transformRequest` gives the file a real,
   *      react-refresh-accepting JS module so later writes take the normal
   *      js-update path. Warming is now only an optimization — the guard
   *      holds even when a write burst outruns it. Never throws — a
   *      half-written file's transform failure is swallowed (no overlay;
   *      the next write re-warms).
   */
  warmDirs?: string[];
} = {}): SandboxOverridesVite {
  let server: ViteDevServer | undefined;
  let redirects = new Map<string, string>();
  const excludeHot = new Set(
    (options.excludeHotFiles ?? []).map(normalizeModulePath),
  );
  const warmDirs = (options.warmDirs ?? []).map(normalizeModulePath);
  /** Pending warm timers by posix path — earliest-wins so a write burst can
   * never postpone warming indefinitely (a delay-0 request upgrades). */
  const pendingWarm = new Map<string, ReturnType<typeof setTimeout>>();

  function isWarmDirFile(posix: string): boolean {
    return warmDirs.some((dir) => posix.startsWith(`${dir}/`));
  }

  /** The durable index is the sandbox home's SIBLING (`sandbox-index.ts`,
   * moved out of the `@source` dir by O1) but designbook rewrites it on every
   * persist — same designbook-owned, never-app-imported write class, so the
   * full-reload guard must cover it too (live-run finding: its `create`
   * dragged a stale resolve-failed scaffold module into vite's update set and
   * dead-ended into `page reload .designbook/sandbox-index.ts`). */
  function isGuardedFile(posix: string): boolean {
    return (
      isWarmDirFile(posix) || warmDirs.some((dir) => posix === `${dir}-index.ts`)
    );
  }

  /** Transform a generated file into a real JS module (see warmDirs doc).
   * No-op when one already exists or the server isn't up yet. */
  function warm(posix: string, delayMs: number): void {
    const devServer = server;
    if (!devServer) return;
    const mods = devServer.moduleGraph.getModulesByFile(posix);
    const hasJsModule =
      mods &&
      [...mods].some((mod) => (mod as { type?: string }).type !== "asset");
    if (hasJsModule) return;
    const existing = pendingWarm.get(posix);
    if (existing !== undefined) {
      // Earliest-wins: never push a pending warm out; only an immediate
      // request (delay 0) replaces a still-waiting debounce.
      if (delayMs > 0) return;
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      pendingWarm.delete(posix);
      const root = normalizeModulePath(devServer.config.root);
      const url = posix.startsWith(`${root}/`)
        ? posix.slice(root.length)
        : `/@fs/${posix}`;
      devServer.transformRequest(url).catch(() => {});
    }, delayMs);
    timer.unref?.();
    pendingWarm.set(posix, timer);
  }
  /** Importer modules pending a hot push (deduped across invalidations). */
  const pendingHotModules = new Set<import("vite").ModuleNode>();
  /** Dev-only gate input — resolveId refuses anything but a dev serve. */
  let env = { command: "unknown", isProduction: true };

  const host: ModuleOverrideHost = {
    originalBypassMarker: `?${ORIGINAL_BYPASS_QUERY}`,
    redirect(map) {
      redirects = new Map(map);
    },
    invalidate(moduleId) {
      if (!server) return;
      const mods = server.moduleGraph.getModulesByFile(
        normalizeModulePath(moduleId),
      );
      if (!mods) return;
      const seen = new Set<unknown>();
      for (const mod of mods) {
        if (seen.has(mod)) continue;
        seen.add(mod);
        for (const importer of mod.importers) {
          // HOT-update only importers that ACCEPT their own updates
          // (react-refresh component modules). A non-accepting importer —
          // e.g. the designbook config, whose HMR chain ends in the boot
          // module's dynamic import — would escalate the push to a FULL
          // RELOAD (live-run finding); it is invalidated silently instead
          // and picks the redirect up on its next natural fetch.
          if (
            importer.isSelfAccepting === true &&
            importer.file &&
            !excludeHot.has(normalizeModulePath(importer.file))
          ) {
            pendingHotModules.add(importer);
          } else {
            server.moduleGraph.invalidateModule(importer);
          }
        }
        server.moduleGraph.invalidateModule(mod);
      }
    },
    hotUpdate() {
      if (!server) {
        pendingHotModules.clear();
        return;
      }
      // Vite's OWN module-reload path (`server.reloadModule` — invalidate +
      // targeted js-update push): the importer re-executes, its imports
      // re-resolve through the redirect, react-refresh re-renders in place.
      // Never a watcher emit (a change event on an already-invalidated
      // module escalated to a full reload — live-run finding), never a full
      // reload frame.
      for (const mod of pendingHotModules) {
        void server.reloadModule(mod).catch(() => {});
      }
      pendingHotModules.clear();
    },
  };

  const driver = createOverrideHostDriver(host);

  let lastVersion: number | undefined;
  async function poll(fetchRedirects: () => Promise<RedirectsPayload | undefined>) {
    try {
      const payload = await fetchRedirects();
      if (!payload || typeof payload.version !== "number") return;
      if (payload.version === lastVersion) return;
      lastVersion = payload.version;
      driver.apply(payload.redirects ?? {}, payload.stamps ?? {});
    } catch {
      // Sidecar unreachable — keep the current table; next tick retries.
    }
  }

  const plugin: Plugin = {
    name: "designbook:sandbox-overrides",
    // Dev-only hard gate #1: the plugin does not exist in builds.
    apply: "serve",
    // `resolveId` must run BEFORE vite's core resolver (vite 7 resolves
    // module specifiers ahead of normal-phase user plugins — live-run
    // finding: a normal-phase hook never sees import specifiers at all).
    enforce: "pre",
    config(_config, configEnv) {
      const isProduction = (configEnv as { isProduction?: boolean })
        .isProduction;
      env = {
        command: configEnv.command,
        isProduction: isProduction ?? configEnv.mode === "production",
      };
    },
    configureServer(devServer) {
      server = devServer;

      // HTTP-DATA REDIRECT (changeset layers, L2 follow-up of the L1
      // deferred note): data files fetched over HTTP (i18next-http-backend
      // style GET /locales/xx/app.json — root- or publicDir-served) never
      // enter the module graph, so `resolveId` can't redirect them. This
      // middleware runs BEFORE vite's static middlewares and serves the
      // redirect target (the merged data artifact) whenever the request
      // path maps to a redirected file. Dev-only by construction (the
      // plugin is serve-only and the table is empty outside a dev serve);
      // ETags deliberately omitted — data merges are tiny and re-fetches
      // must always see the current merge.
      devServer.middlewares.use(
        (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          if (redirects.size === 0) return next();
          if (req.method !== "GET" && req.method !== "HEAD") return next();
          const rawUrl = req.url ?? "";
          const queryIndex = rawUrl.indexOf("?");
          // Module-graph requests (?import, ?direct, …) go to the transform
          // pipeline — the resolveId redirect covers them.
          if (
            queryIndex !== -1 &&
            VITE_MODULE_QUERY.test(rawUrl.slice(queryIndex))
          ) {
            return next();
          }
          let urlPath = rawUrl.split("?")[0];
          try {
            urlPath = decodeURIComponent(urlPath);
          } catch {
            return next();
          }
          if (!urlPath.startsWith("/") || urlPath.includes("..")) {
            return next();
          }
          const contentType = HTTP_DATA_CONTENT_TYPES[extname(urlPath)];
          if (!contentType) return next();
          const root = normalizeModulePath(devServer.config.root);
          const publicDir = devServer.config.publicDir
            ? normalizeModulePath(devServer.config.publicDir)
            : "";
          const candidates = [
            `${root}${urlPath}`,
            ...(publicDir ? [`${publicDir}${urlPath}`] : []),
          ];
          const alt = candidates
            .map((candidate) => redirects.get(candidate))
            .find((match) => match !== undefined);
          if (!alt) return next();
          readFile(alt)
            .then((content) => {
              res.setHeader("Content-Type", contentType);
              res.setHeader("Cache-Control", "no-store");
              res.end(req.method === "HEAD" ? undefined : content);
            })
            .catch(() => next());
        },
      );

      // Generated-file module warming (see `warmDirs` doc, layer 2): a short
      // debounce coalesces a landing's write burst; only files with NO real
      // JS module are warmed (imported variants already have one). Files that
      // EXIST at boot are warmed up front — a model overwriting a
      // pre-existing, never-imported variant file used to race the watcher
      // path (live-run finding; the pre-ordered hotUpdate guard now backstops
      // that race deterministically).
      if (warmDirs.length > 0) {
        const onGeneratedFile = (file: string) => {
          const posix = normalizeModulePath(file);
          if (!posix.endsWith(".tsx")) return;
          if (!isWarmDirFile(posix)) return;
          warm(posix, 100);
        };
        devServer.watcher.on("add", onGeneratedFile);
        devServer.watcher.on("change", onGeneratedFile);
        devServer.httpServer?.once("close", () => {
          devServer.watcher.off("add", onGeneratedFile);
          devServer.watcher.off("change", onGeneratedFile);
        });
        // Boot sweep, once the server accepts requests.
        const bootWarm = setTimeout(() => {
          for (const dir of warmDirs) {
            let entries: Array<{ name: string; parentPath?: string }>;
            try {
              entries = readdirSync(dir, {
                recursive: true,
                withFileTypes: true,
              }) as unknown as Array<{ name: string; parentPath?: string }>;
            } catch {
              continue; // No sandbox home yet.
            }
            for (const entry of entries) {
              if (!entry.name.endsWith(".tsx")) continue;
              const abs = normalizeModulePath(
                join(entry.parentPath ?? dir, entry.name),
              );
              warm(abs, 0);
            }
          }
        }, 500);
        bootWarm.unref?.();
      }

      if (!options.fetchRedirects) return;
      const fetchRedirects = options.fetchRedirects;
      void poll(fetchRedirects);
      const timer = setInterval(() => {
        void poll(fetchRedirects);
      }, REDIRECTS_POLL_MS);
      timer.unref?.();
      devServer.httpServer?.once("close", () => clearInterval(timer));
    },
    // Full-reload guard for generated-file writes (see `warmDirs` doc,
    // layer 1). Hook-level `order: "pre"` outranks plugin array position in
    // vite's hotUpdate sort, so this ALWAYS filters the module list before
    // @tailwindcss/vite's hook (its silent full-reload needs a non-empty,
    // asset-only list) and before vite core's propagation (whose dead end on
    // an unreferenced module logs `page reload <file>`). The invariant the
    // sidecar's write paths rely on: a write under the sandbox home can
    // never surface an unknown/unreferenced-file change to later hooks.
    hotUpdate: {
      order: "pre",
      handler({ type, file, modules }) {
        if (warmDirs.length === 0) return;
        const posix = normalizeModulePath(file);
        if (!isGuardedFile(posix)) return;
        // Immediate warm (no debounce): restores the native js-update path
        // for the NEXT write as fast as the transform allows. Never on
        // deletes (file is gone) and never for the index (no markup).
        if (type !== "delete" && posix.endsWith(".tsx") && isWarmDirFile(posix)) {
          warm(posix, 0);
        }
        // Keep ONLY modules the native hot path handles safely: analyzed JS
        // modules that self-accept (react-refresh components, shims) or have
        // importers to propagate through. Everything else is dropped:
        //   - tailwind's asset-only entries (its silent full-reload class);
        //   - warmed-but-unreferenced modules and deletes' stale modules
        //     (vite core's dead-end `page reload` class);
        //   - stale resolve-FAILED modules that `create` events drag in
        //     (vite adds ALL _hasResolveFailedErrorModules to every create —
        //     a raw scaffold copy's unresolved relative imports otherwise
        //     dead-end the INDEX write's create into a reload).
        // Dropped JS modules are invalidated (same as vite's own handling),
        // so the next natural fetch re-transforms fresh content; asset
        // entries stay tailwind's bookkeeping. Utility freshness rides the
        // entry-css re-emit in generatedTailwindRefresh, which hooks the
        // watcher directly and never sees this filter.
        const keep = modules.filter(
          (mod) =>
            mod.type !== "asset" &&
            mod.id != null &&
            (mod.isSelfAccepting === true || mod.importers.size > 0),
        );
        if (keep.length === modules.length) return; // nothing to drop — native
        for (const mod of modules) {
          if (keep.includes(mod) || mod.type === "asset") continue;
          this.environment.moduleGraph.invalidateModule(mod);
        }
        return keep;
      },
    },
    async resolveId(id, importer, resolveOptions) {
      // LAYER-ALT IMPORTERS (changeset layers): an alternative lives at the
      // real file's repo-relative path MIRRORED under
      // `.designbook/changesets/<id>/alts/<altId>/`, and its imports must
      // resolve AS IF the file sat at the real location (overlay
      // semantics): relative siblings fall through to the real tree, and
      // the redirect table then applies to overridden siblings (topmost
      // active layer wins). Remap the importer before resolution.
      const remapped = importer
        ? (normalizeModulePath(importer)
            .split("?")[0]
            .match(
              /^(.*)\/\.designbook\/changesets\/[^/]+\/alts\/[^/]+\/(.+)$/,
            ) as [string, string, string] | null)
        : null;
      const effectiveImporter = remapped
        ? `${remapped[1]}/${remapped[2]}`
        : importer;
      // Bypass: a read of the ORIGINAL under an override — strip the marker,
      // resolve normally, return the real module id (single graph node;
      // loop-proof because this branch never consults the redirect table).
      if (hasBypassMarker(id)) {
        const resolved = await this.resolve(
          stripBypassMarker(id),
          effectiveImporter,
          {
            skipSelf: true,
            ...(resolveOptions ? { custom: resolveOptions.custom } : {}),
          },
        );
        return resolved ? resolved.id : undefined;
      }
      if (redirects.size === 0 && !remapped) return undefined;
      const resolved = await this.resolve(id, effectiveImporter, {
        skipSelf: true,
        ...(resolveOptions ? { custom: resolveOptions.custom } : {}),
      });
      if (resolved && !resolved.external) {
        const alt = resolveOverrideRedirect({
          resolvedId: resolved.id,
          redirects,
          env,
        });
        // A remapped (layer-alt) importer must return ITS resolution even
        // without a redirect — falling through would re-resolve against the
        // alt's physical dir and miss the real tree.
        return alt ?? (remapped ? resolved.id : undefined);
      }
      if (resolved) return undefined; // External — never redirected.
      // LAYER-ONLY NEW FILES (changeset layers): a variant may ADD a module
      // that exists only inside the layer. Normal resolution fails (no real
      // file), so probe the redirect table with the importer-relative
      // candidates a real file at that path WOULD have resolved to.
      if (!effectiveImporter || !/^\.\.?\//.test(id)) return undefined;
      const importerDir = normalizeModulePath(effectiveImporter)
        .split("?")[0]
        .replace(/\/[^/]*$/, "");
      const segments = importerDir.split("/");
      for (const part of id.split("?")[0].split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") segments.pop();
        else segments.push(part);
      }
      const base = segments.join("/");
      const candidates = /\.[a-z]+$/.test(base)
        ? [base]
        : [
            `${base}.tsx`,
            `${base}.ts`,
            `${base}.jsx`,
            `${base}.js`,
            `${base}/index.tsx`,
            `${base}/index.ts`,
          ];
      for (const candidate of candidates) {
        const alt = resolveOverrideRedirect({
          resolvedId: candidate,
          redirects,
          env,
        });
        if (alt) return alt;
      }
      return undefined;
    },
  };

  return { plugin, apply: (map, stamps) => driver.apply(map, stamps) };
}

export { createSandboxOverridesVite, REDIRECTS_POLL_MS };
export type { RedirectsPayload, SandboxOverridesVite };
