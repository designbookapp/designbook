/**
 * Hot Tailwind regeneration for designbook-GENERATED files
 * (`.designbook/sandbox/**`, `.designbook/variations/**`).
 *
 * Root cause (verified live against Vite 7.3 + @tailwindcss/vite 4.3, sidecar
 * topology): when a NEW file appears under a Tailwind source dir, Vite's
 * watcher fires but `moduleGraph.getModulesByFile(file)` is empty, so
 * `handleHMRUpdate` logs `[no modules matched]` and stops — and
 * @tailwindcss/vite's own `hotUpdate` hook requires a non-empty module list,
 * so it bails too. Nothing invalidates the Tailwind entry css. Worse, it is
 * STICKY: the entry's transform cache stays stale, so even a full page reload
 * is served the pre-write CSS, and later `change` events to those same files
 * still match no modules (Tailwind only registers per-file watch deps for
 * files that existed at its last generate). Edits to files the scanner has
 * already seen work fine — Tailwind registered them as file-only module-graph
 * deps of the entry css, so a change invalidates the entry and Vite pushes a
 * plain css hot update.
 *
 * The variations/sandbox flow lands ONLY brand-new files (a variant module, a
 * pin's wrapper) that nothing in the app imports statically — exactly the
 * unhandled case. Fix at the same seam Vite itself uses: when a generated
 * file lands, re-emit a watcher `change` for each Tailwind v4 entry css in
 * the module graph. That is byte-for-byte the native "user touched the entry
 * css" path (verified: invalidates every module for the file across
 * environments, sends the standard `css-update` / `js-update` frames — a
 * `<style>` swap in the browser, NO full reload, no React state loss), and
 * @tailwindcss/vite's generate() re-scans its sources on every rebuild, which
 * picks up the new files' utilities.
 *
 * Used by BOTH topologies: the injected plugin (plugin.ts — the target app's
 * Vite, whose root already watches `.designbook/*`) and host mode (server.ts
 * — designbook's own Vite, whose root is the packaged UI, so the generated
 * dirs must be watcher.add()ed explicitly).
 *
 * Deliberately NOT wired to designbook's data-write suppression
 * (hmrSuppress.ts): adapter writes (theme/flag/i18n) stay suppressed; this
 * module only ever reacts to files under the two generated dirs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHANGESETS_DIRNAME,
  importsTailwindV4,
  SANDBOX_DIRNAME,
  VARIATIONS_DIRNAME,
} from "./variationsTailwindSource.ts";

/** Coalesce a landing's burst of writes (variant + wrapper + record). */
const DEFAULT_DEBOUNCE_MS = 80;

/**
 * The slice of a Vite dev server this module needs (kept narrow so tests can
 * fake it; `ViteDevServer` satisfies it structurally).
 */
export interface TailwindRefreshServer {
  moduleGraph: { fileToModulesMap: Map<string, unknown> };
  watcher: {
    add(paths: string | readonly string[]): unknown;
    on(event: string, listener: (path: string) => void): unknown;
    off(event: string, listener: (path: string) => void): unknown;
    emit(event: string, ...args: unknown[]): boolean;
  };
}

/** The generated dirs (absolute) for an app root (the config file's dir). */
export function generatedTailwindDirs(appRoot: string): string[] {
  return [
    join(appRoot, SANDBOX_DIRNAME),
    join(appRoot, VARIATIONS_DIRNAME),
    join(appRoot, CHANGESETS_DIRNAME),
  ];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Is this watcher-event file a generated file whose landing should refresh
 * Tailwind? The durable records (`<dir>/index.ts`) are excluded: they carry
 * no markup, and the sandbox one is rewritten on every canvas drag — reacting
 * to it would rebuild css per drag tick. The sandbox `overrides/` dir (O1
 * shims + switch runtime) is excluded too: shims render other modules and
 * carry no utility classes, so regenerating them must never churn the entry
 * css (variant files — which DO carry utilities — land outside it).
 */
export function isGeneratedTailwindSourceFile(
  file: string,
  appRoot: string,
): boolean {
  const posix = toPosix(file);
  for (const dir of generatedTailwindDirs(appRoot)) {
    const prefix = `${toPosix(dir)}/`;
    if (!posix.startsWith(prefix)) continue;
    if (posix === `${prefix}index.ts`) return false;
    if (posix.startsWith(`${prefix}overrides/`)) return false;
    // Changeset LAYERS: only CODE alternatives carry utility classes.
    // meta.json flips, base/ snapshots (never rendered), and the _merged
    // data artifacts must not churn the entry css per flip/drag.
    if (prefix === `${toPosix(join(appRoot, CHANGESETS_DIRNAME))}/`) {
      if (posix.startsWith(`${prefix}_merged/`)) return false;
      const inLayer = posix.slice(prefix.length).split("/").slice(1);
      if (inLayer[0] === "base") return false;
      if (inLayer.join("/") === "meta.json") return false;
      return /\.(tsx|ts|jsx|js)$/.test(posix);
    }
    return true;
  }
  return false;
}

function defaultReadCss(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The Tailwind v4 entry css files among the module graph's files — the ones
 * whose invalidation makes @tailwindcss/vite rebuild (same predicate as the
 * `@source`-append plugins, so both features agree on what "an entry" is).
 */
export function findTailwindEntryCssFiles(
  files: Iterable<string>,
  readCss: (file: string) => string | undefined = defaultReadCss,
): string[] {
  const entries: string[] = [];
  for (const file of files) {
    if (!file.toLowerCase().endsWith(".css")) continue;
    const code = readCss(file);
    if (code !== undefined && importsTailwindV4(code)) entries.push(file);
  }
  return entries;
}

export interface GeneratedTailwindRefresh {
  /** Feed a watcher add/change path; schedules a debounced refresh when it
   * is a generated file. */
  handleWatchEvent(file: string): void;
  /** Run the refresh now (cancels a pending debounce). Returns the entry css
   * files a `change` was emitted for. */
  flush(): string[];
  dispose(): void;
}

export function createGeneratedTailwindRefresh(options: {
  server: TailwindRefreshServer;
  /** Dir owning `.designbook/` — the config file's dir. */
  appRoot: string;
  debounceMs?: number;
  readCss?: (file: string) => string | undefined;
  log?: (message: string) => void;
}): GeneratedTailwindRefresh {
  const {
    server,
    appRoot,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    readCss = defaultReadCss,
    log,
  } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function flush(): string[] {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const entries = findTailwindEntryCssFiles(
      server.moduleGraph.fileToModulesMap.keys(),
      readCss,
    );
    for (const file of entries) {
      // Native path re-entry: identical to the user touching the entry css,
      // minus the disk write (see module doc).
      server.watcher.emit("change", file);
    }
    if (entries.length > 0) {
      log?.(
        `[designbook] generated-file tailwind refresh: ${entries
          .map((f) => toPosix(f).split("/").pop())
          .join(", ")}`,
      );
    }
    return entries;
  }

  function handleWatchEvent(file: string): void {
    if (disposed) return;
    if (typeof file !== "string") return;
    if (!isGeneratedTailwindSourceFile(file, appRoot)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, debounceMs);
    timer.unref?.();
  }

  return {
    handleWatchEvent,
    flush,
    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * Wire the refresh into a dev server's watcher: watch the generated dirs
 * (host mode: they sit OUTSIDE designbook's Vite root; chokidar v3 accepts
 * not-yet-existing paths and starts emitting once created — injected mode
 * already watches them via the app root, where add() is a dedupe no-op) and
 * react to file add/change. `dispose` unhooks the listeners.
 */
export function wireGeneratedTailwindRefresh(
  server: TailwindRefreshServer,
  appRoot: string,
  options: {
    debounceMs?: number;
    readCss?: (file: string) => string | undefined;
    log?: (message: string) => void;
  } = {},
): GeneratedTailwindRefresh {
  const refresh = createGeneratedTailwindRefresh({ server, appRoot, ...options });
  server.watcher.add(generatedTailwindDirs(appRoot));
  const onFile = (file: string) => refresh.handleWatchEvent(file);
  server.watcher.on("add", onFile);
  server.watcher.on("change", onFile);
  return {
    handleWatchEvent: refresh.handleWatchEvent,
    flush: refresh.flush,
    dispose() {
      server.watcher.off("add", onFile);
      server.watcher.off("change", onFile);
      refresh.dispose();
    },
  };
}
