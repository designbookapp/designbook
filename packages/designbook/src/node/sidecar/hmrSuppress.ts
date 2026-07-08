/**
 * Shared HMR-suppression primitives.
 *
 * designbook writes files through its own data endpoints (a flag edit via
 * `POST /api/json`, a token edit via `POST /api/style`, a text edit via
 * `POST /api/po` / `/api/i18n`). The adapter that made the edit already reflects
 * it optimistically in memory, so the corresponding disk write must NOT trigger
 * an HMR reload (which would reset canvas/panel state).
 *
 * Two escapes are needed depending on the file:
 *   - locale JSON / `.po` catalogs live OUTSIDE the module graph, so a change
 *     fires a Vite full-reload. They are silenced up front via `watch.ignored`
 *     ({@link HMR_WATCH_IGNORED}).
 *   - flag `.json` / token `.css` files often ARE in (or reachable from) the
 *     graph, so they can't be blanket-ignored. Instead a short-lived record of
 *     "designbook just wrote this path" ({@link createRecentWrites}) is
 *     consulted in `handleHotUpdate` and matching updates are dropped.
 *
 * Host mode (server.ts) owns the record in-process. The injected plugin
 * (plugin.ts) runs in the TARGET app's Vite — a SEPARATE process from the
 * sidecar that owns the writes — so it fetches the record over HTTP
 * (`GET /api/recent-writes`). Both consume it through the same pure matcher.
 */

import { isAbsolute, relative } from "node:path";
import type { ModuleGraph } from "vite";

/**
 * Glob patterns for files designbook writes that are NOT in the module graph
 * (i18n catalogs). Applied to a Vite server's `server.watch.ignored` so their
 * change never fires a full-reload. In the injected plugin these MERGE with the
 * target app's own ignores (Vite `mergeConfig` concatenates arrays).
 */
export const HMR_WATCH_IGNORED = ["**/locales/**", "**/*.po"];

/**
 * Extensions of managed writes that stay in the watch graph (flag JSON, token
 * CSS). Locale JSON / `.po` are handled by {@link HMR_WATCH_IGNORED} instead.
 * The plugin uses this to decide when a just-arrived hot update is worth an
 * on-demand recent-writes check (the 1s poll may not have seen the write yet).
 */
export const MANAGED_WRITE_EXTENSIONS = [".json", ".css"];

/**
 * Is this a hot update for a plain stylesheet, safe to let through even when
 * designbook itself just wrote the file?
 *
 * The blanket "drop the update" suppression exists to protect
 * React component state: a flag-JSON edit is reachable from a JS module, and
 * re-running that module tree would reset the app the adapter is trying to
 * repaint live. A plain CSS file has no such hazard — Vite's own CSS HMR is a
 * `<style>` textContent swap (no module re-execution, no React state loss) —
 * so suppressing it only serves to make the adapter's own edit invisible until
 * a full reload.
 *
 * Deliberately keyed on the FILE EXTENSION alone, not on the `.type` of the
 * `ModuleNode`s Vite's `handleHotUpdate` found for it
 * (`ctx.modules.map(m => m.type)`) — that was tried and measured wrong in
 * practice: Vite only tags a module `"css"` for a *direct* stylesheet request
 * (an internal `?direct` marker used for e.g. an SSR-emitted `<link>`).  A
 * completely ordinary `import "./tokens.css"` from a `.tsx`/`.ts` module — the
 * shape every designbook theme-adapter CSS source actually takes — is tagged
 * `"js"` in the module graph, because Vite compiles that import into a small
 * JS shim that self-injects/updates a `<style>` tag. That shim is *always*
 * HMR self-accepting (Vite wires it up automatically), so re-running it never
 * cascades to importers or resets React state — the exact property this
 * function is trying to detect. Gating on `moduleTypes` would (and did)
 * misclassify the common case as unsafe and suppress it. designbook only ever
 * writes token values into plain, non-CSS-modules stylesheets (see
 * `themeAdapter`'s `isCssSource`), so the extension alone is a reliable
 * signal here.
 */
export function isCssOnlyHotUpdate(file: string): boolean {
  return file.toLowerCase().endsWith(".css");
}

/** Normalize a path for comparison: forward slashes, no `./` or leading `/`. */
export function normalizeRel(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/** Repo-relative, normalized form of an absolute OR already-relative path. */
export function toRepoRel(projectRoot: string, absOrRel: string): string {
  const rel = isAbsolute(absOrRel) ? relative(projectRoot, absOrRel) : absOrRel;
  return normalizeRel(rel);
}

/**
 * Does an absolute hot-update file (`ctx.file`) match one of the recent
 * repo-relative writes? Robust to abs-vs-relative mismatch: compares the file's
 * own repo-relative form, an exact normalized match, and a path-suffix match
 * (covers a different projectRoot on either side, e.g. a git worktree).
 */
export function hotUpdateMatches(
  absFile: string,
  recentRelPaths: Iterable<string>,
  projectRoot: string,
): boolean {
  const abs = absFile.replace(/\\/g, "/");
  const rel = normalizeRel(relative(projectRoot, absFile));
  for (const raw of recentRelPaths) {
    const cand = normalizeRel(raw);
    if (!cand) continue;
    if (rel === cand) return true;
    if (abs === cand) return true;
    if (abs.endsWith(`/${cand}`)) return true;
  }
  return false;
}

/** A single recorded write: repo-relative path + record timestamp. */
export interface RecentWrite {
  path: string;
  ts: number;
}

/**
 * A short-lived, self-pruning record of repo-relative paths designbook just
 * wrote. Entries expire after `ttlMs` so a stale record can't swallow a later
 * genuine edit to the same file.
 */
export interface RecentWrites {
  readonly ttlMs: number;
  /** Record (or refresh) a repo-relative write path. */
  record(repoRelPath: string, now?: number): void;
  /** Non-expired entries with their timestamps. */
  list(now?: number): RecentWrite[];
  /** Non-expired paths only (matcher input). */
  paths(now?: number): string[];
  /** Drop expired entries. */
  prune(now?: number): void;
}

/**
 * From a polled recent-writes payload, the writes not yet seen at their
 * current timestamp (a re-write of the same path gets a fresh ts and shows up
 * again). Mutates `seen` to remember what it returned. Used by the injected
 * plugin to invalidate Vite's module-graph entries for files designbook wrote:
 * locale catalogs sit in `watch.ignored` (HMR_WATCH_IGNORED), so the watcher
 * never invalidates their transform cache and a frame/page reload would be
 * served the PRE-edit compiled module forever.
 */
export function selectNewWrites(
  writes: RecentWrite[],
  seen: Map<string, number>,
): RecentWrite[] {
  const fresh: RecentWrite[] = [];
  for (const write of writes) {
    const key = normalizeRel(write.path);
    if (!key || typeof write.ts !== "number") continue;
    if (seen.get(key) === write.ts) continue;
    seen.set(key, write.ts);
    fresh.push({ path: key, ts: write.ts });
  }
  // Bound the memory: forget entries no longer present in the payload window.
  const live = new Set(writes.map((w) => normalizeRel(w.path)));
  for (const key of seen.keys()) {
    if (!live.has(key)) seen.delete(key);
  }
  return fresh;
}

/**
 * Invalidate every module-graph entry whose file matches `writtenRelPath` (a
 * repo-relative path designbook just wrote). Shared shape of the injected
 * plugin's `invalidateWrittenModules` loop (plugin.ts) and host mode's
 * `onDataWrite`-driven equivalent (server.ts) — both need it because a write
 * `handleHotUpdate` suppresses (returns `[]`) is never
 * invalidated by Vite itself, and a locale/`.po` write (silenced entirely via
 * `HMR_WATCH_IGNORED`, never reaching `handleHotUpdate` at all) is NEVER
 * invalidated any other way. Without this, the next fetch/import of that
 * module (a component re-render, a page reload) is served the pre-edit
 * compiled content until the dev server restarts. Idempotent/cheap to call
 * even for a write Vite already invalidated on its own (e.g. a CSS write let
 * through normally, see `isCssOnlyHotUpdate`) — invalidating an
 * already-fresh module is a no-op.
 */
export function invalidateModulesForWrite(
  moduleGraph: ModuleGraph,
  writtenRelPath: string,
  projectRoot: string,
): void {
  for (const [file, mods] of moduleGraph.fileToModulesMap) {
    if (!hotUpdateMatches(file, [writtenRelPath], projectRoot)) continue;
    for (const mod of mods) moduleGraph.invalidateModule(mod);
  }
}

export function createRecentWrites(ttlMs = 5000): RecentWrites {
  const writes = new Map<string, number>();

  function prune(now = Date.now()): void {
    for (const [path, ts] of writes) {
      if (now - ts > ttlMs) writes.delete(path);
    }
  }

  return {
    ttlMs,
    record(repoRelPath, now = Date.now()) {
      const key = normalizeRel(repoRelPath);
      if (!key) return;
      writes.set(key, now);
      prune(now);
    },
    list(now = Date.now()) {
      prune(now);
      return [...writes].map(([path, ts]) => ({ path, ts }));
    },
    paths(now = Date.now()) {
      prune(now);
      return [...writes.keys()];
    },
    prune,
  };
}
