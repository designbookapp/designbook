/**
 * ModuleOverrideHost seam + the bundler-agnostic redirect controller
 * (docs/specs/sandbox-overrides.md §Build-environment portability).
 *
 * All override LOGIC lives here, behind the minimal 4-method host seam; a
 * bundler plugin implements the seam (~a screen of code — vite does it via
 * `resolveId`, see src/node/plugin/sandboxOverridesVite.ts) and inherits the
 * feature. NOTHING in this module (or anywhere under src/node/overrides/)
 * imports vite — enforced by overridesSeam.test.ts.
 *
 * DEV-ONLY HARD GATE: `resolveOverrideRedirect` refuses to redirect outside a
 * dev serve (`command !== "serve"` / `isProduction`) — a production/build
 * pass can never see a shim even if a host were (mis)wired into one. The
 * vite plugins are additionally `apply: "serve"`, so they don't exist in
 * builds at all; this gate is the belt to that suspender.
 */

/** Query marker whose presence bypasses the module redirect (loop-proofing:
 * reads of the ORIGINAL under an override go through it — e.g. the layer
 * engine reading a real file that a changeset layer currently shadows).
 * Host-specific spelling lives in `ModuleOverrideHost.originalBypassMarker`;
 * this is the canonical value the vite hosts use. */
const ORIGINAL_BYPASS_QUERY = "db-original";

/**
 * The minimal host contract a build environment implements (spec verbatim):
 * apply/refresh the redirect table, expose the bypass spelling, invalidate a
 * module's importers on first override, and push the hot update — NEVER a
 * full reload.
 */
interface ModuleOverrideHost {
  /** Apply/refresh the redirect table (absolute real path → absolute shim
   * path, posix-normalized by the controller before this call). */
  redirect(map: ReadonlyMap<string, string>): void;
  /** The host-specific original-bypass marker (e.g. `?db-original`). */
  originalBypassMarker: string;
  /** Invalidate `moduleId`'s compiled importers so their next execution
   * re-resolves imports (picking up / dropping the redirect). */
  invalidate(moduleId: string): void;
  /** Push the pending invalidations as a HOT update — never a full reload. */
  hotUpdate(): void;
}

/** Normalize an absolute path for map identity (windows-safe). */
function normalizeModulePath(absPath: string): string {
  return absPath.replace(/\\/g, "/");
}

/**
 * PURE redirect resolution for a host's resolve hook. `resolvedId` is the
 * fully-resolved module id (query allowed); returns the shim path to redirect
 * to, or undefined. The dev-only hard gate lives HERE so every host inherits
 * it: anything but a dev serve resolves nothing.
 */
function resolveOverrideRedirect(params: {
  resolvedId: string;
  redirects: ReadonlyMap<string, string>;
  /** The build environment's mode: only `{ command: "serve", isProduction:
   * false }` may redirect (vite's ConfigEnv shape, but plain data). */
  env: { command: string; isProduction?: boolean };
}): string | undefined {
  const { resolvedId, redirects, env } = params;
  if (env.command !== "serve" || env.isProduction === true) return undefined;
  if (redirects.size === 0) return undefined;
  const [bare, query] = resolvedId.split("?");
  // Bypass marker: the shim's own import of the original must NOT loop back
  // into the redirect.
  if (query && query.split("&").includes(ORIGINAL_BYPASS_QUERY)) {
    return undefined;
  }
  const clean = normalizeModulePath(bare);
  const shim = redirects.get(clean);
  if (!shim) return undefined;
  // A shim must never redirect to itself (identity mapping guard).
  if (normalizeModulePath(shim) === clean) return undefined;
  return shim;
}

/** True when `id` (an unresolved import specifier) carries the bypass marker. */
function hasBypassMarker(id: string): boolean {
  const query = id.split("?")[1];
  return Boolean(query && query.split("&").includes(ORIGINAL_BYPASS_QUERY));
}

/** Strip the bypass marker (and only it) from an import specifier. */
function stripBypassMarker(id: string): string {
  const [bare, query] = id.split("?");
  if (!query) return bare;
  const rest = query.split("&").filter((part) => part !== ORIGINAL_BYPASS_QUERY);
  return rest.length > 0 ? `${bare}?${rest.join("&")}` : bare;
}

/**
 * The controller driving one host: diffs each new redirect table against the
 * previous one, and — for every ADDED module (first-time override) — runs ONE
 * importer invalidation + hot update; for every REMOVED module the SHIM's
 * importers are invalidated instead (they must re-resolve back to the
 * original). A VALUE-CHANGED entry (layers: a flip from one alternative to
 * another) invalidates BOTH sides — the real path may not be in the module
 * graph at all once an alternative is loaded (imports resolved straight to
 * the alt), so the PREVIOUS backing module's importers carry the hot update
 * (live-run finding, L2). A STAMP-CHANGED entry (same paths, re-projected
 * CONTENT — park/rollback/turn-end rewrite the alt file in place) is treated
 * exactly like a value change: both sides invalidate and the shim's
 * importers carry the hot update, so a content-only re-projection re-renders
 * deterministically instead of racing the host's file watcher (the
 * canvas-staleness bug). Unchanged tables are a no-op (byte-stable targets
 * + idempotent pushes make repeated applies free).
 */
function createOverrideHostDriver(host: ModuleOverrideHost): {
  apply(
    redirects: Record<string, string>,
    stamps?: Record<string, number>,
  ): void;
  current(): ReadonlyMap<string, string>;
} {
  let previous = new Map<string, string>();
  let previousStamps = new Map<string, number>();

  function apply(
    redirects: Record<string, string>,
    stamps: Record<string, number> = {},
  ): void {
    const next = new Map<string, string>();
    for (const key of Object.keys(redirects).sort()) {
      next.set(normalizeModulePath(key), normalizeModulePath(redirects[key]));
    }
    const nextStamps = new Map<string, number>();
    for (const key of Object.keys(stamps)) {
      nextStamps.set(normalizeModulePath(key), stamps[key]);
    }
    const added: string[] = [];
    const removedShims: string[] = [];
    for (const [real, shim] of next) {
      if (!previous.has(real)) added.push(real);
      else if (previous.get(real) !== shim) {
        added.push(real);
        removedShims.push(previous.get(real)!);
      } else {
        const stamp = nextStamps.get(real);
        if (stamp !== undefined && stamp !== previousStamps.get(real)) {
          // Content-only re-projection: same real→shim mapping, new bytes.
          added.push(real);
          removedShims.push(shim);
        }
      }
    }
    for (const [real, shim] of previous) {
      if (!next.has(real)) removedShims.push(shim);
    }
    if (added.length === 0 && removedShims.length === 0) {
      host.redirect(next); // Refresh (identical content) — no invalidation.
      previous = next;
      previousStamps = nextStamps;
      return;
    }
    host.redirect(next);
    for (const real of added) host.invalidate(real);
    for (const shim of removedShims) host.invalidate(shim);
    host.hotUpdate();
    previous = next;
    previousStamps = nextStamps;
  }

  return { apply, current: () => previous };
}

export {
  createOverrideHostDriver,
  hasBypassMarker,
  normalizeModulePath,
  ORIGINAL_BYPASS_QUERY,
  resolveOverrideRedirect,
  stripBypassMarker,
};
export type { ModuleOverrideHost };
