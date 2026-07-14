/**
 * `designbookPlugin()` — the dev-only Vite plugin that injects the designbook
 * toolbar + workbench overlay into a target app's own dev server (injected
 * mode). designbook becomes a dev dependency of the app; this plugin adds
 * a SEPARATE module-script entry that the app's own bundler compiles with the
 * app's React + aliases, backed by an API-only sidecar (the existing
 * `designbook` CLI) reached cross-origin via `serverUrl`.
 *
 * Everything is gated on `apply: "serve"` — nothing touches the production build.
 *
 * Injection seam:
 *   1. `transformIndexHtml` appends `<script type="module"
 *      src="/@id/virtual:designbook-boot">`. A separate module graph means the
 *      app's own entry throwing cannot take the toolbar/overlay down with it.
 *   2. `virtual:designbook-boot` (resolveId/load) is a small module that renders
 *      a shadow-hosted toolbar pill immediately, lazy-loads the PREBUILT
 *      `dist/ui` workbench only on first expand, and passes `dist/ui/style.css`
 *      as TEXT into the shadow root (never linked globally — Tailwind preflight
 *      must not reach the app).
 *
 * The user config is imported through the app's OWN pipeline (`/@fs/<config>`),
 * so its aliases / tailwind / providers all just work.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import { findDefaultConfig, PRIMARY_CONFIG_NAME } from "../config/configDiscovery.ts";
import { deepLinkBootstrapHtml } from "../sidecar/sidecarSupport.ts";
import {
  MARK_MODULE_SOURCE,
  VIRTUAL_MARK_ID,
  transformPageText,
} from "./pageTextTransform.ts";
import {
  createRecentWrites,
  HMR_WATCH_IGNORED,
  hotUpdateMatches,
  isCssOnlyHotUpdate,
  MANAGED_WRITE_EXTENSIONS,
  selectNewWrites,
  type RecentWrite,
} from "../sidecar/hmrSuppress.ts";
import { isFlushWritesRequest } from "../sidecar/flushWrites.ts";
import { wireGeneratedTailwindRefresh } from "../lib/generatedTailwindRefresh.ts";
import { generatedDirsTailwindSourcePlugin } from "../lib/variationsTailwindSource.ts";
import {
  createSandboxOverridesVite,
  type RedirectsPayload,
} from "./sandboxOverridesVite.ts";
import {
  createExportIndex,
  isIndexableModuleId,
  scanComponentExports,
} from "./exportIndex.ts";

/** dist/node/plugin.js → package root (dist/ui and dist/node live under it). */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const VIRTUAL_BOOT_ID = "virtual:designbook-boot";
const BOOT_URL = `/@id/${VIRTUAL_BOOT_ID}`;

/**
 * Base path under which the sidecar serves ITS OWN api on the proxy origin. The
 * proxy forwards plain `/api/*` to the target app (so the app's own same-origin
 * `/api` keeps working); designbook's api lives under `/__designbook/api/*`. The
 * injected client reaches it by using `serverUrl + DESIGNBOOK_API_BASE` as its
 * api origin (works same-origin through the proxy AND cross-origin against the
 * sidecar directly).
 */
const DESIGNBOOK_API_BASE = "/__designbook";

interface DesignbookPluginOptions {
  /**
   * Path to the user's `designbook.config.tsx` (absolute, or relative to the
   * Vite config's cwd). Defaults to auto-discovery in cwd, like the CLI.
   */
  config?: string;
  /**
   * Origin of the designbook sidecar serving `/api/*` (the `designbook` CLI).
   * Default `http://localhost:8787`. Its port must match the sidecar's.
   */
  serverUrl?: string;
  /** Auto-expand the overlay on load (deep-link/dev convenience). Default false. */
  autoExpand?: boolean;
  /**
   * Rewrite the app's i18n call sites so the page text tool can attribute
   * live strings by exact key. Dev-serve only, opt-out with `false`. When off,
   * page text editing falls back to instrumenting the app's real i18n instance
   * (config `pageText.i18n`). Default true.
   */
  pageTextTransform?: boolean;
}

/** Nearest ancestor (inclusive) containing a `.git`, else undefined. */
function findGitRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Body of the injected boot module, served to the browser and compiled by the
 * TARGET app's Vite (their React, their aliases). Plain JS — no JSX / TS — so it
 * needs no transform beyond Vite's import rewriting. Values are baked in as
 * literals; everything the browser fetches goes through the app's dev server.
 */
function bootSource(params: {
  distIndexUrl: string;
  distCssUrl: string;
  configUrl: string;
  configDir: string;
  serverUrl: string;
  autoExpand: boolean;
}): string {
  const {
    distIndexUrl,
    distCssUrl,
    configUrl,
    configDir,
    serverUrl,
    autoExpand,
  } = params;

  return `
import React from "react";
import { createRoot } from "react-dom/client";

const DIST_INDEX = ${JSON.stringify(distIndexUrl)};
const DIST_CSS = ${JSON.stringify(distCssUrl)};
const CONFIG_URL = ${JSON.stringify(configUrl)};
const CONFIG_DIR = ${JSON.stringify(configDir)};
const SERVER_URL = ${JSON.stringify(serverUrl)};
const AUTO_EXPAND = ${autoExpand ? "true" : "false"};

// --- Recursion guard ---------------------------------------------
// A live App-page frame cell (this SAME dev server, same plugin) — or a stray
// reload of one — re-runs this exact boot module. Bail before ANY side effect
// below (persist writes, the reload-defer WebSocket patch, crash listeners, the
// toolbar mount): a half-booted designbook inside a frame would corrupt the
// TOP document's sessionStorage (shared per-origin) and paint a second toolbar.
// Two independent, either-is-enough signals:
//   - \`?__designbook_frame=1\` on THIS document's own URL (belt-and-suspenders;
//     set by \`buildFrameSrc\` in the UI package's frame-cell code).
//   - framed (\`window.top !== window.self\`) under a window.top that carries the
//     \`window.__designbook\` marker (same-origin reachable — set unconditionally,
//     below, by every non-framed designbook-injected page's own boot). A
//     cross-origin parent throws on read and is treated as "no marker", not a
//     match — mirrors the pure predicate unit-tested in src/node/frameGuard.ts
//     (shouldBailAsFrame); duplicated here by hand since this runs in the
//     browser before any module graph (including that file) exists.
let __dbTopHasMarker;
try {
  __dbTopHasMarker = !!(window.top && window.top.__designbook);
} catch (e) {
  __dbTopHasMarker = undefined;
}
const __dbFramed =
  new URLSearchParams(window.location.search).get("__designbook_frame") === "1" ||
  (window.top !== window.self && __dbTopHasMarker === true);

if (!__dbFramed) {

// --- Reload rehydration -----------------------------------------------
// The boot module owns the \`expanded\` / \`deferredReloadPending\` fields of the
// single versioned sessionStorage blob (the workbench owns the rest); both do
// read-merge-write so neither clobbers the other. Keyed by project root so
// multiple apps don't collide. PERSIST_VERSION MUST match src/ui/workbenchPersist.ts.
const PERSIST_VERSION = 1;
const STORAGE_KEY = "designbook:wb:" + (CONFIG_DIR || ".");
function readPersist() {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || obj.v !== PERSIST_VERSION) return null;
    return obj;
  } catch (e) {
    return null;
  }
}
function writePersist(fields) {
  try {
    const cur = readPersist() || { v: PERSIST_VERSION };
    const next = Object.assign({}, cur, fields, { v: PERSIST_VERSION });
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (e) {}
}

// Deep-link handoff: the /__designbook[/component/<id>] route stashes
// these in sessionStorage then redirects to "/". Read + clear them here so a
// later manual reload doesn't re-trigger the auto-expand. The component id is
// cleared but otherwise ignored — the registry/component pages are retired;
// a component deep link now just opens the full view.
let autoExpandFromSession = false;
try {
  const s = window.sessionStorage;
  if (s.getItem("designbook:autoExpand") === "1") {
    autoExpandFromSession = true;
    s.removeItem("designbook:autoExpand");
  }
  if (s.getItem("designbook:deepLink")) s.removeItem("designbook:deepLink");
} catch (e) {}

// Mutable UI state, painted imperatively — the toolbar is a pure function of it
// (no hooks), driven entirely from outside so crash/expand events can repaint.
const state = { expanded: false, loading: false, crashed: false, queuedReload: false, error: null };
let handle = null;
let workbenchPromise = null;

// --- Loading elapsed-time ticker ---------------------------------------------
// The FIRST expand can take 30s+ on a big module graph (the app's Vite is
// transforming/dep-optimizing cold). We show elapsed seconds so it never looks
// hung, and we NEVER impose an artificial timeout — let it cook. The pill only
// leaves "loading" when the mount resolves (workbench up) or rejects (red error
// pill, click-to-retry). A Vite dep-optimize full-reload mid-load is handled by
// persisting the expand intent up front (see expand()), so the reboot re-enters
// loading rather than silently dropping back to an idle pill.
let loadStartedAt = 0;
let loadTicker = null;
function startLoadTicker() {
  loadStartedAt = Date.now();
  if (loadTicker) clearInterval(loadTicker);
  loadTicker = setInterval(paint, 1000);
}
function stopLoadTicker() {
  if (loadTicker) { clearInterval(loadTicker); loadTicker = null; }
}
function loadingLabel() {
  const secs = loadStartedAt ? Math.floor((Date.now() - loadStartedAt) / 1000) : 0;
  return secs > 0
    ? "\\u25C8 designbook \\u2014 loading\\u2026 " + secs + "s"
    : "\\u25C8 designbook \\u2014 loading\\u2026";
}

// --- Deferred full-reload ---------------------------------------------
// While the overlay is EXPANDED, a Vite full-reload would blow away the canvas.
// Two guards cancel it and queue it instead:
//   1. The inline head script (injected before @vite/client) intercepts the
//      'full-reload' WS frame and calls g.onDeferredReload. This is the ONLY
//      mechanism that works on Vite 5 (its client swallows a thrown
//      vite:beforeFullReload listener via Promise.allSettled).
//   2. import.meta.hot's vite:beforeFullReload throw-to-cancel — the native
//      Vite 6/7 path, kept as a belt-and-suspenders fallback if the WS
//      interceptor didn't install (e.g. a non-WebSocket HMR transport).
// While COLLAPSED, neither fires and full reloads proceed untouched.
const g = (window.__designbook = window.__designbook || {});
g.expanded = false;
g.onDeferredReload = function () {
  if (!state.expanded) return; // collapsed: let it through (shouldn't reach here)
  if (!state.queuedReload) {
    state.queuedReload = true;
    writePersist({ deferredReloadPending: true });
    paint();
  }
};
function applyDeferredReload() {
  // Execute the queued reload (pill click or collapse-with-queue).
  window.location.reload();
}

// --- Toolbar (own shadow host + own React root, independent of the workbench
// chunk) ---------------------------------------------------------------------
const toolbarHost = document.createElement("div");
toolbarHost.id = "designbook-toolbar";
// Above the overlay (z 2147483000) so the pill stays clickable while expanded.
toolbarHost.style.cssText =
  "position:fixed;right:16px;bottom:16px;z-index:2147483001;";
document.body.appendChild(toolbarHost);
const toolbarShadow = toolbarHost.attachShadow({ mode: "open" });
const toolbarMount = document.createElement("div");
toolbarShadow.appendChild(toolbarMount);
const toolbarRoot = createRoot(toolbarMount);

const PILL_STYLE = {
  font: "13px system-ui, sans-serif",
  padding: "10px 16px",
  borderRadius: "999px",
  border: "none",
  background: "#0b0d10",
  color: "#e6e6e6",
  boxShadow: "0 4px 16px rgba(0,0,0,.3)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
};

// --- Entry/exit: pencil/play EVERYWHERE ---------------------------------
// The bottom-LEFT perfectly-round pencil expands the overlay straight into
// the full view (the only designbook UI), and the view's own play button
// collapses it back via g.collapseOverlay. There is no pill and no page-mode
// strip anymore. The pencil's metrics MUST mirror the full view's
// .dbproto-playbtn exactly: fixed left 16 / bottom 16, 44px, radius 50%.
//
// Legacy prototype route: #/proto/full-view used to be the full view's
// address. Redirect muscle memory — strip the hash and expand.
const LEGACY_PROTO_HASH = "#/proto/full-view";
function consumeLegacyProtoHash() {
  if (window.location.hash !== LEGACY_PROTO_HASH) return false;
  try {
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  } catch (e) {}
  return true;
}
window.addEventListener("hashchange", function () {
  if (consumeLegacyProtoHash() && !state.expanded) void expand();
});

const PENCIL_STYLE = {
  position: "fixed",
  left: "16px",
  bottom: "16px",
  width: "44px",
  height: "44px",
  padding: "0",
  borderRadius: "50%",
  border: "none",
  background: "#1f6feb",
  color: "#fff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  boxShadow: "0 6px 22px rgba(31,111,235,.5), 0 0 0 1px rgba(255,255,255,.12)",
};

function pencilIcon() {
  return React.createElement(
    "svg",
    {
      width: 18,
      height: 18,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    React.createElement("path", {
      d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
    }),
    React.createElement("path", { d: "m15 5 4 4" }),
  );
}

function Toolbar() {
  const children = [];
  if (state.error && !state.expanded) {
    // Config/mount failure: show the reason and let the user retry the mount.
    children.push(
      React.createElement(
        "button",
        {
          key: "error",
          onClick: () => { state.error = null; openAnyway(); },
          title: state.error,
          style: {
            ...PILL_STYLE,
            background: "#3a0d0d",
            color: "#ffb4b4",
            maxWidth: "420px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        },
        "\\u26A0 designbook — " + state.error,
      ),
    );
  } else if (state.crashed && !state.expanded) {
    children.push(
      React.createElement(
        "button",
        {
          key: "crash",
          onClick: openAnyway,
          style: { ...PILL_STYLE, background: "#3a0d0d", color: "#ffb4b4" },
        },
        "\\u26A0 designbook — open anyway",
      ),
    );
  } else {
    // "app updated — reload" pill: shown while a full reload is deferred (the
    // overlay is open). Click applies it. Sits left of the main pill.
    if (state.queuedReload && state.expanded) {
      children.push(
        React.createElement(
          "button",
          {
            key: "reload",
            onClick: applyDeferredReload,
            style: { ...PILL_STYLE, background: "#12331a", color: "#8ff0a4", marginRight: "8px" },
          },
          "\\u21BB app updated — reload",
        ),
      );
    }
    // Pencil/play everywhere: the pencil (collapsed state) expands STRAIGHT
    // into the full view; while expanded there is no pill at all — the
    // view's play button owns the exit (g.collapseOverlay).
    if (!state.expanded) {
      children.push(
        React.createElement(
          "button",
          {
            key: "pencil",
            onClick: function () { void expand(); },
            title: state.loading ? loadingLabel() : "Edit (open designbook)",
            style: Object.assign({}, PENCIL_STYLE, state.loading ? { opacity: 0.7 } : null),
          },
          pencilIcon(),
        ),
      );
    }
  }
  return React.createElement(React.Fragment, null, children);
}

function paint() {
  toolbarRoot.render(React.createElement(Toolbar));
}

// --- Workbench (lazy: mounted only on first expand) --------------------------
function ensureWorkbench() {
  if (workbenchPromise) return workbenchPromise;
  state.loading = true;
  state.error = null;
  startLoadTicker();
  paint();
  workbenchPromise = Promise.all([
    import(/* @vite-ignore */ DIST_INDEX),
    import(/* @vite-ignore */ DIST_CSS),
    import(/* @vite-ignore */ CONFIG_URL),
  ])
    .then(([ui, cssMod, cfgMod]) => {
      state.error = null;
      handle = ui.mountWorkbench({
        container: document.body,
        config: cfgMod.default ?? cfgMod.config ?? cfgMod,
        configDir: CONFIG_DIR,
        serverUrl: SERVER_URL,
        // Injected mode: keep route + UI state in memory + sessionStorage; never
        // touch the target app's URL.
        routing: "memory",
        isolation: "shadow",
        overlay: true,
        startCollapsed: true,
        styles: cssMod.default,
      });
      return handle;
    })
    .catch((err) => {
      workbenchPromise = null;
      // Surface the reason in the toolbar instead of leaving the user with a
      // dead pill. Config-module evaluation errors (the user's own code) land
      // here — show the first line so it is diagnosable without the console.
      const msg = err && err.message ? String(err.message) : String(err);
      state.error = msg.split("\\n").find((l) => l.trim()) || "failed to mount";
      console.error("[designbook] failed to mount workbench", err);
      throw err;
    })
    .finally(() => {
      state.loading = false;
      stopLoadTicker();
      paint();
    });
  return workbenchPromise;
}

async function expand() {
  // Persist the expand INTENT before we start loading: if a Vite dep-optimize
  // full-reload lands mid-load (the classic cause of a silent drop back to a
  // dead pencil), the reboot sees expanded=true and re-enters loading instead.
  writePersist({ expanded: true });
  // The full view lands on the live page's CURRENT route — captured before
  // the (possibly slow) first mount so a mid-load app navigation can't skew it.
  const appPath = window.location.pathname + window.location.search;
  try {
    const h = await ensureWorkbench();
    h.expand();
    state.expanded = true;
    g.expanded = true;
    paint();
    if (typeof h.navigateToApp === "function") h.navigateToApp(appPath);
  } catch {
    // ensureWorkbench already logged + reset; keep the toolbar responsive.
  }
}

function collapse() {
  if (handle) handle.collapse();
  state.expanded = false;
  g.expanded = false;
  writePersist({ expanded: false });
  // A reload deferred while open is applied on collapse (the whole reason to
  // collapse is usually to get the fresh app).
  if (state.queuedReload) {
    applyDeferredReload();
    return;
  }
  paint();
}
// Seam for the full view's play button: exit the overlay back to the
// running app (there is no pill — the pencil/play pair owns entry/exit).
g.collapseOverlay = collapse;

function openAnyway() {
  void expand();
}

// --- Crash surfacing ---------------------------------------------------------
// If the app's own entry throws, the workbench still mounts its own components.
// Surface an "open anyway" affordance instead of a blank page.
function onCrash(event) {
  const real =
    event &&
    (event.type === "unhandledrejection" || event.error != null);
  if (real && !state.crashed) {
    state.crashed = true;
    paint();
  }
}
window.addEventListener("error", onCrash);
window.addEventListener("unhandledrejection", onCrash);

// Vite 6/7 native defer: throwing inside a vite:beforeFullReload listener
// cancels the reload (the client awaits the listener). Vite 5's client does
// NOT await it (Promise.allSettled swallows the throw), so the inline WS
// interceptor is what actually covers excalidraw — this is the fallback.
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", () => {
    if (state.expanded) {
      g.onDeferredReload();
      throw new Error("[designbook] full reload deferred (workbench open)");
    }
  });
}

// Reload rehydration: if the overlay was expanded before the reload,
// re-expand and let the workbench rehydrate from the persist blob (route,
// selection, transform, tab/tool, draft, …). Setting g.expanded EARLY makes a
// full-reload frame that lands during rehydrate get deferred, not applied. The
// deferred-reload flag is a one-shot — clear it so the "app updated" pill does
// not reappear after the reload it triggered.
const persisted = readPersist();
const restoreExpanded = !!(persisted && persisted.expanded);
if (restoreExpanded) {
  g.expanded = true;
  writePersist({ deferredReloadPending: false });
}
paint();
// Legacy #/proto/full-view on load counts as an expand request.
const legacyProtoEntry = consumeLegacyProtoHash();
if (AUTO_EXPAND || autoExpandFromSession || restoreExpanded || legacyProtoEntry) {
  void expand();
}

} // end recursion guard (if (!__dbFramed))
`;
}

/**
 * Inline CLASSIC script injected into <head>, BEFORE Vite's `@vite/client`.
 *
 * Timing: `@vite/client` is a `type="module"` script, so it is deferred until
 * after HTML parsing; a classic inline script runs during parsing, i.e. FIRST.
 * That lets us replace `window.WebSocket` before Vite constructs its HMR
 * socket, so our message listener is registered (inside the constructor) BEFORE
 * Vite's own — letting `stopImmediatePropagation()` drop a 'full-reload' frame
 * before Vite's client ever sees it. This is the reload-defer mechanism that
 * works on Vite 5 (whose client swallows a thrown vite:beforeFullReload
 * listener). Only 'full-reload' frames are touched, and only while the boot
 * module has set `window.__designbook.expanded` — every other socket and frame
 * (their HMR 'update' frames, app websockets) is untouched.
 *
 * Runs the SAME recursion guard as `bootSource` before touching
 * anything: a framed App-page cell must not even install the patched
 * WebSocket wrapper, let alone create the `window.__designbook` marker other
 * (non-framed) pages rely on for their own child frames' guard check.
 */
const RELOAD_GUARD_SOURCE = `
(function () {
  var framed = false;
  try {
    var topHasMarker;
    try {
      topHasMarker = !!(window.top && window.top.__designbook);
    } catch (e) {
      topHasMarker = undefined;
    }
    framed =
      new URLSearchParams(window.location.search).get("__designbook_frame") === "1" ||
      (window.top !== window.self && topHasMarker === true);
  } catch (e) {}
  if (framed) return;
  var g = (window.__designbook = window.__designbook || {});
  var Orig = window.WebSocket;
  if (typeof Orig !== "function") return;
  function Patched(url, protocols) {
    var ws = arguments.length > 1 ? new Orig(url, protocols) : new Orig(url);
    ws.addEventListener("message", function (ev) {
      if (!g.expanded) return;
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data && data.type === "full-reload") {
        ev.stopImmediatePropagation();
        if (typeof g.onDeferredReload === "function") g.onDeferredReload(data);
      }
    });
    return ws;
  }
  Patched.prototype = Orig.prototype;
  Patched.CONNECTING = Orig.CONNECTING;
  Patched.OPEN = Orig.OPEN;
  Patched.CLOSING = Orig.CLOSING;
  Patched.CLOSED = Orig.CLOSED;
  window.WebSocket = Patched;
})();
`;

/**
 * The designbook dev plugin. Add it to the target app's Vite config (a
 * `vite.designbook.config.mts` variant is the recommended shape) and run the
 * sidecar alongside it.
 *
 * Recommended convention: add a `"design": "designbook dev"` script to
 * package.json. `designbook dev` runs the API sidecar on the stable port
 * (`serverUrl`, default 8787) AND proxies the app's own dev server behind it,
 * so the user sees ONE URL: the app renders through the proxy with the injected
 * toolbar; `/api/*` is same-origin (no CORS); a recovery page with the Pi chat
 * appears if the app crashes; worktree switches keep the URL stable. It spawns
 * the app's `dev` script by default — override with `designbook dev
 * --target-cmd "<cmd>"`, or attach to a running server with `--target-url
 * <url>` (see `designbook dev --help`).
 *
 * Deep links: `/__designbook` opens the app with the overlay auto-expanded;
 * `/__designbook/component/<entryId>` also navigates to that component. Served
 * by both the sidecar proxy and this plugin (so it works on either port).
 *
 * Returns a plugin ARRAY (Vite flattens nested arrays in `plugins`): the main
 * injection plugin plus a tiny css transform that appends
 * `@source ".designbook/{sandbox,variations}"` to the app's Tailwind v4 entry
 * so generated variants' utilities exist even when `.designbook/` is
 * gitignored (Tailwind's default source detection skips gitignored paths).
 */
function designbookPlugin(options: DesignbookPluginOptions = {}): Plugin[] {
  const cwd = process.cwd();
  const configPath = options.config
    ? isAbsolute(options.config)
      ? options.config
      : resolve(cwd, options.config)
    : findDefaultConfig(cwd);

  if (!configPath || !existsSync(configPath)) {
    throw new Error(
      `[designbook] config file not found${
        options.config ? `: ${configPath}` : ` (looked for ${PRIMARY_CONFIG_NAME} in ${cwd})`
      }. Pass { config } to designbookPlugin().`,
    );
  }

  // configDir mirrors host mode: repo-relative dir of the config file, used by
  // the workbench to resolve glob-keyed source paths.
  const projectRoot =
    findGitRoot(dirname(configPath)) ?? dirname(configPath);
  const configDir = relativePosix(projectRoot, dirname(configPath)) || ".";

  const serverUrl = (options.serverUrl ?? "http://localhost:8787").replace(
    /\/+$/,
    "",
  );
  // The origin the injected client points its `/api/*` calls at. designbook's
  // api is namespaced under `/__designbook` on the sidecar (the plain `/api/*`
  // path on the proxy origin belongs to the TARGET app now). apiUrl() in the UI
  // does `serverUrl + path`, so baking the base in here makes every workbench
  // call land on `/__designbook/api/*`.
  const clientServerUrl = `${serverUrl}${DESIGNBOOK_API_BASE}`;
  const autoExpand = options.autoExpand ?? false;
  const pageTextTransform = options.pageTextTransform ?? true;

  // Normalized (posix) paths whose modules the page-text transform must NOT
  // touch — designbook's own prebuilt lib + the user's config file (served via
  // /@fs). The app's own source is everything else.
  const packageRootPosix = toPosix(packageRoot);
  const configPathPosix = toPosix(configPath);

  /** Whether the page-text transform should rewrite this module id. */
  function shouldTransformPageText(id: string): boolean {
    if (!pageTextTransform) return false;
    const clean = id.split("?")[0];
    if (clean.startsWith("\0")) return false;
    if (clean.includes("virtual:")) return false;
    if (clean.includes("/node_modules/")) return false;
    if (!/\.[cm]?[jt]sx?$/.test(clean)) return false;
    const posix = toPosix(clean);
    if (posix === configPathPosix) return false;
    if (posix.startsWith(`${packageRootPosix}/`)) return false;
    return true;
  }

  // Auto export index (config-slim spec): scan every client-graph module this
  // transform sees and mirror the full snapshot to the sidecar (debounced),
  // where it replaces the config registry for hit-test labels + the sandbox
  // export-scan ladder. A 15s re-push heals sidecar restarts (memory-only
  // store there); failures degrade silently — consumers fall back to the scan.
  const exportIndex = createExportIndex();
  const projectRootPosix = toPosix(projectRoot);
  let pushTimer: ReturnType<typeof setTimeout> | undefined;

  async function pushExportIndex(): Promise<void> {
    const { version, files } = exportIndex.snapshot();
    if (version === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(`${serverUrl}${DESIGNBOOK_API_BASE}/api/export-index`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files }),
        signal: controller.signal,
      });
    } catch {
      // Sidecar down — the interval re-push covers it.
    } finally {
      clearTimeout(timer);
    }
  }

  function scheduleExportIndexPush(): void {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      void pushExportIndex();
    }, 500);
    pushTimer.unref?.();
  }

  function maybeIndexExports(code: string, id: string): void {
    if (
      !isIndexableModuleId(id, {
        projectRoot: projectRootPosix,
        packageRoot: packageRootPosix,
        configPath: configPathPosix,
      })
    ) {
      return;
    }
    const repoRel = toPosix(id.split("?")[0]).slice(projectRootPosix.length + 1);
    if (exportIndex.update(repoRel, scanComponentExports(code, repoRel))) {
      scheduleExportIndexPush();
    }
  }

  // Cross-process write-suppression: the sidecar (a SEPARATE process) owns the
  // record of paths designbook just wrote. We poll it and drop the matching
  // hot updates in this (the target app's) Vite so an adapter-managed write
  // doesn't reload the app. Degrades silently when the sidecar is unreachable.
  const recentWrites = createRecentWrites();
  let sidecarReachable = true;

  // `watch.ignored` keeps designbook-written locale catalogs from
  // firing full-reloads — but it also means Vite NEVER invalidates their
  // transform cache, so any later fetch of the compiled module (App-page
  // frame reload, top-page reload) is served the pre-edit content until the
  // dev server restarts. Invalidate the module-graph entries for
  // each newly polled write ourselves — invalidation only drops the server
  // cache; it broadcasts nothing, so the prevent behavior is untouched.
  let devServerRef: ViteDevServer | undefined;
  const invalidatedWrites = new Map<string, number>();

  function invalidateWrittenModules(writes: RecentWrite[]): void {
    const server = devServerRef;
    if (!server) return;
    for (const write of selectNewWrites(writes, invalidatedWrites)) {
      for (const [file, mods] of server.moduleGraph.fileToModulesMap) {
        if (!hotUpdateMatches(file, [write.path], projectRoot)) continue;
        for (const mod of mods) server.moduleGraph.invalidateModule(mod);
      }
    }
  }

  async function fetchRecentWrites(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const res = await fetch(
        `${serverUrl}${DESIGNBOOK_API_BASE}/api/recent-writes`,
        { signal: controller.signal },
      );
      sidecarReachable = res.ok;
      if (!res.ok) return;
      const body = (await res.json()) as {
        writes?: Array<{ path?: unknown; ts?: unknown }>;
      };
      if (Array.isArray(body.writes)) {
        const valid: RecentWrite[] = [];
        for (const write of body.writes) {
          if (typeof write?.path === "string") {
            recentWrites.record(write.path);
            if (typeof write.ts === "number") {
              valid.push({ path: write.path, ts: write.ts });
            }
          }
        }
        invalidateWrittenModules(valid);
      }
    } catch {
      sidecarReachable = false;
    } finally {
      clearTimeout(timer);
    }
  }

  const source = bootSource({
    // `/@fs/<abs>` serves files outside the app's Vite root (the prebuilt lib
    // lives in the designbook package, the config may be above the app root).
    distIndexUrl: `/@fs/${packageRoot}/dist/ui/index.js`,
    distCssUrl: `/@fs/${packageRoot}/dist/ui/style.css?raw`,
    configUrl: `/@fs/${configPath}`,
    configDir,
    serverUrl: clientServerUrl,
    autoExpand,
  });

  const mainPlugin: Plugin = {
    name: "designbook",
    apply: "serve",
    config() {
      return {
        // Allow serving the out-of-root prebuilt lib + config via /@fs.
        server: {
          fs: {
            allow: [packageRoot, projectRoot],
          },
          // Write-suppression: i18n catalogs designbook writes aren't in the module
          // graph, so a change fires a full-reload. Ignore them. `mergeConfig`
          // CONCATENATES arrays, so this adds to the app's own `watch.ignored`
          // rather than replacing it.
          watch: {
            ignored: [...HMR_WATCH_IGNORED],
          },
        },
        // The user config imports `@designbookapp/designbook/config` (defineConfig + types)
        // and, in injected mode, `@designbookapp/designbook/adapters` (themeAdapter, …) — both
        // designbook-package specifiers the target app's build can't reliably
        // resolve on its own (the config is served via /@fs, possibly from
        // above the app root, where node resolution of `designbook/*` is not
        // guaranteed). Point each at the package's PREBUILT dist bundle:
        //   - `@designbookapp/designbook/config`   → dist/config/index.js
        //   - `@designbookapp/designbook/adapters` → dist/ui/adapters.js — the SAME prebuilt
        //     entry the workbench (`dist/ui/index.js`) code-splits its shared
        //     runtime (config store, adapterRuntime) out of, so an app-imported
        //     adapter shares ONE runtime instance with the mounted workbench
        //     (correct configDir + API origin). Aliasing to source instead would
        //     recreate the dual-runtime bug (a second, uninitialized store).
        // Anchored regexes so they can't shadow the app's own `designbook/*`
        // paths, if any.
        //
        // Dedupe: the i18next adapter's `<I18nextProvider>` must share the app's
        // SINGLE react-i18next instance for text attribution (markers) to work.
        // i18next/react-i18next are externalized from dist/ui so the app's own
        // copy is used on both sides — but if a repo ends up with two copies
        // (mismatched ranges across workspaces), the marker provider gets a
        // DIFFERENT context object than the app's components and every string
        // silently reads as "hardcoded" with no hint. We inject the dedupe here
        // so this never becomes a hand-configured footgun: it's a no-op when the
        // app doesn't use i18next (nothing to dedupe), and forces one copy when
        // it does. `mergeConfig` concatenates, so this ADDS to any dedupe the app
        // already declares. (The adapter still requires i18next/react-i18next to
        // be resolvable in the app — dedupe can't conjure a missing dependency.)
        resolve: {
          dedupe: ["react-i18next", "i18next"],
          alias: [
            {
              find: /^@designbookapp\/designbook\/config$/,
              replacement: `${packageRoot}/dist/config/index.js`,
            },
            {
              find: /^@designbookapp\/designbook\/adapters$/,
              replacement: `${packageRoot}/dist/ui/adapters.js`,
            },
          ],
        },
        // The app's dep optimizer must NOT pre-bundle designbook's prebuilt lib
        // entries: esbuild would bundle each standalone, duplicating the shared
        // workbench runtime (a second config store / adapterRuntime → the exact
        // dual-instance bug) and, for the raw-source case, 504 on the internal
        // `@designbook-ui/*` aliases it can't resolve. Excluding them keeps Vite
        // serving the code-split ESM as-is, so both entries import the same
        // shared chunk = one runtime instance. `mergeConfig` concatenates, so
        // this adds to the app's own optimizeDeps.exclude.
        optimizeDeps: {
          exclude: ["@designbookapp/designbook/adapters", "@designbookapp/designbook/ui", "@designbookapp/designbook/config"],
        },
      };
    },
    // Deep-link dev route, served inside the target's OWN dev server so
    // it works when hitting the target port directly (the sidecar proxy serves
    // the identical route on the stable port). `/__designbook[/component/<id>]`
    // stashes auto-expand + deep-link intent in sessionStorage then redirects
    // to "/", where the boot module above consumes it.
    configureServer(devServer) {
      devServerRef = devServer;

      // Hot Tailwind for landed sandbox/variations files: a NEW file under
      // the generated dirs matches no module-graph entry, so neither Vite nor
      // @tailwindcss/vite reacts and the entry css stays stale (even across
      // reloads) until an unrelated edit. Re-emit a `change` on the Tailwind
      // entry css when generated files land — the exact native css hot-update
      // path (style swap, no reload). See generatedTailwindRefresh.ts.
      const generatedRefresh = wireGeneratedTailwindRefresh(
        devServer,
        dirname(configPath),
      );
      devServer.httpServer?.once("close", () => generatedRefresh.dispose());

      devServer.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "/").split("?")[0];

        // Deterministic freshness after a save: the App-page
        // frame text tool calls this right after a successful save, awaiting
        // it before reloading the frame — collapsing the race the 1s poll
        // below used to lose (see `flushWrites.ts`'s doc comment). Reuses the
        // exact same poll+invalidate pass (`fetchRecentWrites` already calls
        // `invalidateWrittenModules`), just run once on demand.
        if (isFlushWritesRequest(pathname, request.method)) {
          void fetchRecentWrites().then(() => {
            response.statusCode = 204;
            response.end();
          });
          return;
        }

        if (
          pathname !== "/__designbook" &&
          !pathname.startsWith("/__designbook/component/")
        ) {
          next();
          return;
        }
        const entryId = pathname.startsWith("/__designbook/component/")
          ? decodeURIComponent(
              pathname.slice("/__designbook/component/".length),
            )
          : undefined;
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(deepLinkBootstrapHtml(entryId));
      });

      // Write-suppression: keep a warm local copy of the sidecar's recent-writes so
      // handleHotUpdate can drop adapter-managed reloads with zero latency in
      // the common case. Always-on 1s poll, unref'd so it never holds the
      // process open; stops when the dev server closes. Silent when the sidecar
      // is down (sidecarReachable flips false; handleHotUpdate skips its
      // on-demand check to avoid stalling legit hot updates).
      const poll = setInterval(() => {
        void fetchRecentWrites();
      }, 1000);
      poll.unref?.();
      devServer.httpServer?.once("close", () => clearInterval(poll));

      // Export-index re-push: heals a sidecar restart (its store is
      // memory-only) without any handshake. Cheap — the snapshot is a small
      // JSON map and no-ops entirely while the index is empty.
      const indexPush = setInterval(() => {
        void pushExportIndex();
      }, 15000);
      indexPush.unref?.();
      devServer.httpServer?.once("close", () => clearInterval(indexPush));
    },
    // Write-suppression: drop the hot update for a file designbook just wrote (the
    // adapter already reflected it in memory). Fast path uses the polled record;
    // for a managed extension (flag JSON / token CSS) that the poll may not have
    // seen yet, do one bounded on-demand fetch so the suppression isn't racy.
    //
    // Exception: a PURE CSS update (token file writes) is let through instead
    // of dropped. Unlike a flag-JSON write (reachable from JS, re-running it
    // would reset React state), a plain stylesheet hot update is just a
    // `<style>` textContent swap — no state loss — and in injected mode the
    // canvas cells' forwarded page tokens (`pageRootTokens`) only ever refresh
    // by observing that exact swap. Suppressing it left both the canvas cells
    // AND the live app page stuck on the pre-edit color until a manual reload.
    async handleHotUpdate(ctx) {
      if (hotUpdateMatches(ctx.file, recentWrites.paths(), projectRoot)) {
        return isCssOnlyHotUpdate(ctx.file) ? undefined : [];
      }
      const lower = ctx.file.toLowerCase();
      const managed = MANAGED_WRITE_EXTENSIONS.some((ext) => lower.endsWith(ext));
      if (managed && sidecarReachable) {
        await fetchRecentWrites();
        if (hotUpdateMatches(ctx.file, recentWrites.paths(), projectRoot)) {
          return isCssOnlyHotUpdate(ctx.file) ? undefined : [];
        }
      }
      return undefined;
    },
    resolveId(id) {
      if (id === VIRTUAL_BOOT_ID) return VIRTUAL_BOOT_ID;
      // Page-text transform injects `import … from "virtual:designbook-mark"`
      // into the app's rewritten modules; resolve it to itself so the app's Vite
      // serves our tiny passthrough helper from `load` below.
      if (pageTextTransform && id === VIRTUAL_MARK_ID) return VIRTUAL_MARK_ID;
      return undefined;
    },
    load(id) {
      if (id === VIRTUAL_BOOT_ID) return source;
      if (pageTextTransform && id === VIRTUAL_MARK_ID) return MARK_MODULE_SOURCE;
      return undefined;
    },
    // Page-text transform: wrap i18n call sites in the app's OWN source.
    // `order: "post"` runs AFTER the app's react/babel + esbuild transforms, so
    // Lingui macros have already compiled to `i18n._(...)` (we match that form)
    // and we parse the lowered output. Gated to the app's source files only.
    transform: {
      order: "post",
      handler(code, id) {
        // Export index: record this module's exported component names (the
        // lowered ESM keeps every `export` form textual). Independent of the
        // page-text option — the index is what hit-testing runs on.
        maybeIndexExports(code, id);
        if (!shouldTransformPageText(id)) return undefined;
        const result = transformPageText(code, id);
        return result ?? undefined;
      },
    },
    transformIndexHtml() {
      return [
        // Reload-defer guard: a CLASSIC inline script in <head> so it runs
        // before the deferred `@vite/client` module and can patch WebSocket
        //. See RELOAD_GUARD_SOURCE.
        {
          tag: "script",
          children: RELOAD_GUARD_SOURCE,
          injectTo: "head-prepend",
        },
        {
          tag: "script",
          attrs: { type: "module", src: BOOT_URL },
          injectTo: "body",
        },
      ];
    },
  };

  // Sandbox overrides (O1): the vite ModuleOverrideHost for the INJECTED
  // topology — the sidecar owns the index/shims in a separate process, so
  // this plugin polls its redirect table (version-gated, same cadence as the
  // recent-writes poll) and applies module→shim redirects via resolveId.
  // `apply: "serve"` + the controller's own dev-only gate keep production
  // builds redirect-free.
  const sandboxOverrides = createSandboxOverridesVite({
    // The config imports registry components but is not in the page tree —
    // hot-emitting it escalates to a full reload (see excludeHotFiles doc).
    excludeHotFiles: [configPath],
    // Landed sandbox files get a real module node so tailwind's scanned-file
    // hotUpdate takes the js-update path, never its silent full-reload.
    warmDirs: [
      join(dirname(configPath), ".designbook/sandbox"),
      // Changeset LAYER alternatives (mirrored-path files) get the same
      // guard/warm treatment (docs/specs/changeset-layers.md, L1).
      join(dirname(configPath), ".designbook/changesets"),
    ],
    fetchRedirects: async (): Promise<RedirectsPayload | undefined> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 800);
      try {
        const res = await fetch(
          `${serverUrl}${DESIGNBOOK_API_BASE}/api/sandbox/redirects`,
          { signal: controller.signal },
        );
        if (!res.ok) return undefined;
        return (await res.json()) as RedirectsPayload;
      } catch {
        return undefined; // Sidecar down — keep the current table.
      } finally {
        clearTimeout(timer);
      }
    },
  });

  return [
    generatedDirsTailwindSourcePlugin(dirname(configPath)),
    mainPlugin,
    sandboxOverrides.plugin,
  ];
}

/** POSIX-style `relative(from, to)` (config dir is a URL-ish path in the UI). */
function relativePosix(from: string, to: string): string {
  return relative(from, to).split("\\").join("/");
}

/** Normalize an absolute path to forward slashes for cross-platform compares. */
function toPosix(path: string): string {
  return path.split("\\").join("/");
}

export { designbookPlugin };
export type { DesignbookPluginOptions };
