/**
 * The designbook server: one Node http server that routes `/api/*` to the Pi
 * agent API and everything else to an embedded Vite dev server (middleware
 * mode) compiling the workbench UI, which ships as source inside this
 * package. The user's config file is exposed to the UI as the
 * `virtual:designbook-config` module.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import {
  createServer as createViteServer,
  type Plugin,
  type PluginOption,
} from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import {
  isCrossOriginExemptApiPath,
  rejectCrossOriginApiRequest,
} from "../plugin/apiOrigin.ts";
import { createApi } from "../api/api.ts";
import {
  createRecentWrites,
  HMR_WATCH_IGNORED,
  hotUpdateMatches,
  invalidateModulesForWrite,
  isCssOnlyHotUpdate,
  toRepoRel,
} from "./hmrSuppress.ts";
import { openBrowser } from "./openBrowser.ts";
import { tailwindPlugins } from "../lib/tailwind.ts";
import {
  sandboxTailwindSourcePlugin,
  variationsTailwindSourcePlugin,
} from "../lib/variationsTailwindSource.ts";
import { buildTailwindBridge, tailwindBridgePlugins } from "../lib/tailwindBridge.ts";
import { wireGeneratedTailwindRefresh } from "../lib/generatedTailwindRefresh.ts";
import { createSandboxOverridesVite } from "../plugin/sandboxOverridesVite.ts";
import {
  filterInheritedPlugins,
  flattenPlugins,
  resolveUserVite,
} from "../lib/userVite.ts";

type DesignbookServerOptions = {
  /** Absolute path to the user's designbook config file. */
  configPath: string;
  /** Absolute path to the repo the agent works in (git root above the config). */
  projectRoot: string;
  port: number;
  host: string;
  /** Open (or refocus) the workbench in a browser once listening. */
  open: boolean;
  /** Verbose logging: every API request and Pi agent event. */
  debug?: boolean;
  /** Restrict the Pi agent to read-only tools and 403 the file-write data endpoints. */
  readOnly?: boolean;
  /** Trust the project's `.pi/` directory (extensions/settings/SYSTEM.md). Default false. */
  trustProject?: boolean;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VIRTUAL_CONFIG_ID = "virtual:designbook-config";

/** Only localhost origins get CORS — the injected `designbookPlugin` runs the
 * target app's dev server on a different localhost port than this sidecar. */
const LOCALHOST_ORIGIN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/**
 * Apply cross-origin headers for `/api/*` requests from a localhost dev server
 *. Reflects the request origin, echoes requested headers,
 * and answers the CORS preflight — including Chrome's Private-Network probe.
 * Returns true when it fully handled the request (an OPTIONS preflight).
 *
 * Host mode is same-origin, so browsers send no `Origin` and nothing here fires
 * — behavior is unchanged.
 */
function applyApiCors(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const origin = request.headers.origin;
  if (typeof origin === "string" && LOCALHOST_ORIGIN.test(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    const requestedHeaders = request.headers["access-control-request-headers"];
    response.setHeader(
      "Access-Control-Allow-Headers",
      typeof requestedHeaders === "string" && requestedHeaders
        ? requestedHeaders
        : "content-type",
    );
    // Chrome's Private Network Access preflight (public/localhost → localhost).
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return true;
  }
  return false;
}
const RESOLVED_CONFIG_ID = "\0designbook-config";

function virtualConfigPlugin(configPath: string, projectRoot: string): Plugin {
  return {
    name: "designbook:config",
    resolveId(id) {
      return id === VIRTUAL_CONFIG_ID ? RESOLVED_CONFIG_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_CONFIG_ID) return undefined;
      const configDir = relative(projectRoot, dirname(configPath)) || ".";
      return [
        `export { default as config } from ${JSON.stringify(configPath)};`,
        `export const configDir = ${JSON.stringify(configDir)};`,
      ].join("\n");
    },
  };
}

async function startDesignbook(options: DesignbookServerOptions) {
  const { configPath, projectRoot, port, host, open, debug, readOnly, trustProject } = options;
  const uiRoot = resolve(packageRoot, "src/ui");

  // Created before Vite so its HMR websocket can share this server instead of
  // binding Vite's default HMR port (24678), which collides when several
  // designbook (or plain Vite) instances run at once.
  const server = createServer();

  // Files designbook writes through its own data endpoints (e.g. a flag edit
  // via POST /api/json). The adapter that made the edit already reflects it
  // optimistically in memory, so the corresponding disk write must NOT trigger
  // an HMR full-reload (which would reset canvas/panel state). The API records
  // the repo-relative path just before writing (via `onDataWrite` below); the
  // plugin drops that one hot-update. Code edits via POST /api/file are
  // deliberately not recorded — those should hot-reload the preview. Shared
  // record + matcher with the injected plugin (see hmrSuppress.ts).
  const recentWrites = createRecentWrites();

  // Bridge the target repo's Vite/TS config into our fixed instance: sidecar
  // designbook.vite.*, auto-detected repo vite.config, tsconfig paths, and
  // Next.js shims. See userVite.ts for precedence rules.
  const userVite = await resolveUserVite({
    configPath,
    projectRoot,
    uiRoot,
    packageRoot,
    log: debug ? (msg) => console.log(msg) : undefined,
  });

  const debugLog = debug ? (m: string) => console.log(m) : () => {};

  // designbook's own fixed plugins, built up front so their `name`s can guard
  // the inherited set (a second vite-tsconfig-paths / @tailwindcss/vite from
  // the repo config is dropped as a collision).
  const configPlugin = virtualConfigPlugin(configPath, projectRoot);
  // Importer-aware tsconfig paths: honors each workspace package's own `paths`
  // (twenty defines `@/` differently per package — flat aliasing is wrong).
  // Our `@designbook-ui` alias resolves earlier, so this can't shadow the
  // workbench. ignoreConfigErrors: a malformed/unrelated tsconfig in a large
  // repo must not abort boot.
  const tsPathsPlugin = tsconfigPaths({ root: projectRoot, ignoreConfigErrors: true });
  // Tailwind v3 -> v4 token bridge. On a v3 repo this synthesizes a v4 `@theme`
  // from the repo's own resolved config (served as a virtual css entry the
  // workbench imports) + a directive shim so the repo's theme css is
  // importable. Inert (empty css, no shim) on v4 / no-Tailwind repos.
  const bridge = await buildTailwindBridge({ configPath, projectRoot, uiRoot, log: debugLog });
  const tailwind = tailwindPlugins({
    uiRoot,
    configDir: dirname(configPath),
    projectRoot,
    autoDetectedPostcssTailwind: userVite.autoDetectedPostcssTailwind,
    // v3 repo: keep Tailwind scoped to designbook's own ui (incl. the bridge
    // entry). The bridge's `@source "<repo>"` still makes v4 scan the repo's
    // components and generate their utilities, but v4 never transforms the
    // repo's own v3-shaped css (which would throw on `@apply`).
    forceScopeToUiRoot: bridge.isV3,
  });
  const bridgePlugins = tailwindBridgePlugins({
    bridge,
    uiRoot,
    projectRoot,
    packageRoot,
    log: debugLog,
  });
  // Sandbox overrides (O1): the vite ModuleOverrideHost for HOST MODE —
  // same process as the api, so the orchestrator pushes the redirect table
  // straight into the driver (no polling). Canvas cells importing an
  // overridden app module resolve to its generated shim. The config module
  // is excluded from hot pushes (same escalation hazard as injected mode).
  const sandboxOverrides = createSandboxOverridesVite({
    excludeHotFiles: [configPath],
    // Same tailwind silent-full-reload hazard as injected mode (its watcher
    // covers the generated dirs via wireGeneratedTailwindRefresh).
    warmDirs: [
      resolve(dirname(configPath), ".designbook/sandbox"),
      // Changeset LAYER alternatives (mirrored-path files) get the same
      // guard/warm treatment (docs/specs/changeset-layers.md, L1).
      resolve(dirname(configPath), ".designbook/changesets"),
    ],
  });

  const suppressHmrPlugin: Plugin = {
    name: "designbook:suppress-managed-hmr",
    handleHotUpdate(ctx) {
      if (hotUpdateMatches(ctx.file, recentWrites.paths(), projectRoot)) {
        // Parity with the injected plugin (plugin.ts): a plain CSS write
        // (token values) is just a `<style>` textContent swap — no module
        // re-execution, no React state loss — so it is let through normally
        // instead of suppressed. Everything else managed (flag JSON, locale)
        // still drops the update; `onDataWrite` below (FIX 2) keeps the
        // module-graph cache for THOSE writes fresh without a live broadcast.
        return isCssOnlyHotUpdate(ctx.file) ? undefined : [];
      }
    },
  };

  // Inherited repo plugins (Storybook model): flatten, then deny-list
  // framework/server plugins, drop any colliding with one of ours, and — if
  // the repo ships @vitejs/plugin-react(-swc) — swap THEIR react plugin into
  // our fixed react slot so their babel/swc config (Lingui macros, Emotion, …)
  // rides along. Sidecar plugins remain appended last (fully trusted).
  const inheritedFlat = await flattenPlugins(userVite.inheritedPlugins);
  const ourPluginNames = new Set<string>();
  for (const p of [configPlugin, tsPathsPlugin, ...tailwind, suppressHmrPlugin]) {
    if (p && "name" in p && p.name) ourPluginNames.add(p.name);
  }
  const {
    react: inheritedReact,
    kept: inheritedKept,
    denied,
  } = filterInheritedPlugins(inheritedFlat, ourPluginNames);

  const inheritedNames = inheritedFlat.map((p) => p.name ?? "(anonymous)");
  if (inheritedFlat.length) {
    debugLog(`[designbook] inherited repo plugins: ${inheritedNames.join(", ")}`);
  }
  if (denied.length) {
    debugLog(
      `[designbook] denied inherited plugins: ${denied
        .map((d) => `${d.name} (${d.reason})`)
        .join(", ")}`,
    );
  }
  const reactSlot: PluginOption[] = inheritedReact.length ? inheritedReact : [react()];
  debugLog(
    inheritedReact.length
      ? `[designbook] react dedupe: using repo's react plugin(s) [${inheritedReact
          .map((p) => p.name)
          .join(", ")}], dropped designbook's own react()`
      : `[designbook] react dedupe: no repo react plugin inherited — keeping designbook's react()`,
  );

  let vite: Awaited<ReturnType<typeof createViteServer>>;
  try {
    vite = await createViteServer({
      configFile: false,
      root: uiRoot,
      appType: "spa",
      cacheDir: resolve(projectRoot, "node_modules/.cache/designbook"),
      server: {
        middlewareMode: true,
        hmr: { server },
        fs: {
          allow: [packageRoot, projectRoot],
        },
        watch: {
          // The text tool writes canvas edits back to i18n catalogs — locale
          // JSON (i18next) and gettext `.po` (Lingui). Those files aren't in the
          // workbench module graph (configs load them via the adapter, not a
          // static import), so a change fires a Vite full-reload that would wipe
          // the adapter's optimistic in-memory update. Ignore them; the in-memory
          // i18next/Lingui store already matches what was written to disk.
          ignored: [...HMR_WATCH_IGNORED],
        },
      },
      ...(userVite.css ? { css: userVite.css } : {}),
      ...(Object.keys(userVite.define).length ? { define: userVite.define } : {}),
      optimizeDeps: userVite.optimizeDeps,
      resolve: {
        // Ordered: designbook's reserved aliases first (they win), then the
        // repo's sidecar/auto-detected aliases, synthesized source aliases,
        // then Next.js shims.
        alias: userVite.alias,
        dedupe: ["react", "react-dom", "i18next", "react-i18next", ...userVite.dedupe],
      },
      plugins: [
        configPlugin,
        tsPathsPlugin,
        // react slot: theirs (inherited) if present, else ours. Kept in the
        // same relative position — before tailwind, after tsconfigPaths.
        ...reactSlot,
        // Bridge plugins BEFORE tailwind: the directive shim is `enforce: "pre"`
        // and must strip v3 `@tailwind` directives before @tailwindcss/vite's
        // own pre-transform sees the repo's css.
        ...bridgePlugins,
        // Variations css coverage BEFORE tailwind: appends an @source for
        // .designbook/variations to v4 entry css so variant-only utilities
        // generate (design-variations spec).
        // App-owned variations home (monorepo rule): <configDir>/.designbook.
        variationsTailwindSourcePlugin(dirname(configPath)),
        // Same coverage for sandbox wrappers/variants (docs/specs/sandbox.md).
        sandboxTailwindSourcePlugin(dirname(configPath)),
        ...tailwind,
        suppressHmrPlugin,
        // Module→shim redirects for overridden app modules (sandbox O1).
        sandboxOverrides.plugin,
        // Inherited (deny-filtered, deduped) repo plugins — e.g. Lingui catalog
        // loader, svgr.
        ...inheritedKept,
        // Sidecar plugins run last — the fully-trusted escape hatch.
        ...userVite.plugins,
      ],
    });
  } catch (err) {
    // An inherited plugin can misbehave outside its framework. Name the full
    // inherited set so the culprit is identifiable; deny it or move config to a
    // designbook.vite sidecar.
    throw new Error(
      `[designbook] Vite dev server failed to start. Inherited repo plugins: [${inheritedNames.join(", ")}]. ` +
        `If one is at fault, it can be denied (framework/server plugins already are) or you can move config into a designbook.vite sidecar.\n` +
        `Original error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
  }

  // Hot Tailwind for landed sandbox/variations files: NEW files under the
  // generated dirs match no module-graph entry, so neither Vite nor
  // @tailwindcss/vite reacts and the Tailwind entry css stays stale (even
  // across reloads) until an unrelated edit. Watch the generated dirs (they
  // sit outside this Vite's root — the packaged UI) and re-emit a `change` on
  // the Tailwind entry css when files land: the exact native css hot-update
  // path (style swap, no reload). See generatedTailwindRefresh.ts. Distinct
  // from the recentWrites suppression above — adapter data writes stay
  // suppressed; this reacts only to `.designbook/{sandbox,variations}` files.
  const generatedRefresh = wireGeneratedTailwindRefresh(
    vite,
    dirname(configPath),
    { log: debugLog },
  );

  const api = createApi({
    configPath,
    projectRoot,
    port,
    debug,
    readOnly,
    trustProject,
    onDataWrite: (absPath) => {
      const rel = toRepoRel(projectRoot, absPath);
      recentWrites.record(rel);
      // FIX 2 (host-mode live-update parity): host mode compiles the app's
      // OWN source through this SAME Vite instance (its cells import the
      // user's real components via `virtual:designbook-config`), so — unlike
      // the injected plugin, a separate process that polls the sidecar's
      // recent-writes over HTTP — the write is already known in-process,
      // right here, before the file even hits disk. Invalidate the matching
      // module-graph entries immediately: a locale/`.po` write never reaches
      // `handleHotUpdate` at all (silenced via `HMR_WATCH_IGNORED`), and a
      // flag-JSON write is one `suppressHmrPlugin` (above) just told Vite to
      // drop — in both cases nothing else would ever invalidate the compiled
      // module, and a component cell's next render/import would keep serving
      // the pre-edit content until a full server restart. This does NOT
      // re-enable the full-reload `suppressHmrPlugin` still prevents; it only
      // keeps the SERVER's transform cache fresh so a re-render/HMR update
      // (or a manual reload) actually shows the new value.
      invalidateModulesForWrite(vite.moduleGraph, rel, projectRoot);
    },
    // Sandbox overrides (O1), host-mode topology: the orchestrator pushes
    // redirect-table changes (and content stamps — content-only
    // re-projections hot-update too) straight into the vite override host.
    onSandboxOverridesChanged: (redirects, stamps) =>
      sandboxOverrides.apply(redirects, stamps),
  });

  server.on("request", (request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    // Accept both plain `/api/*` (host mode is same-origin) and the namespaced
    // `/__designbook/api/*` the injected client uses, so a config pointed at a
    // host-mode server still resolves.
    if (url.pathname.startsWith("/__designbook/api/")) {
      if (applyApiCors(request, response)) return;
      const raw = request.url ?? "/";
      const stripped = new URL(
        raw.slice("/__designbook".length) || "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      if (
        !isCrossOriginExemptApiPath(stripped.pathname) &&
        rejectCrossOriginApiRequest(request, response, host, port)
      )
        return;
      void api.handle(request, response, stripped);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (applyApiCors(request, response)) return;
      if (
        !isCrossOriginExemptApiPath(url.pathname) &&
        rejectCrossOriginApiRequest(request, response, host, port)
      )
        return;
      void api.handle(request, response, url);
      return;
    }

    vite.middlewares(request, response);
  });

  // Integration device bridges: an external tool (e.g. the Figma plugin's UI
  // iframe) opens a WS connection to us — tools can't listen on a socket.
  // Only `/api/bridge/<name>` (plus legacy aliases like `/api/figma-bridge`)
  // upgrades, routed dynamically through the integration registry; Vite's own
  // HMR websocket is attached separately via `hmr.server` above and handles
  // itself.
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    api.handleBridgeUpgrade(url.pathname, request, socket, head);
  });

  // Friendly EADDRINUSE (no stack trace) — the outer CLI catch would otherwise
  // print a full listen-error stack.
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `designbook: port ${port} in use — another designbook running? Use --port to change.`,
      );
      process.exit(1);
    }
    throw error;
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`designbook running at ${url}`);
    console.log(`  config:  ${configPath}`);
    console.log(`  project: ${projectRoot}`);
    if (open) {
      void openBrowser(url);
    }
  });

  async function shutdown() {
    generatedRefresh.dispose();
    await api.shutdown();
    await vite.close();
    server.close();
  }

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  return { server, vite, shutdown };
}

export { startDesignbook };
export type { DesignbookServerOptions };
