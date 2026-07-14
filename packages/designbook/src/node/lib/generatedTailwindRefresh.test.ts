/**
 * Hot Tailwind regeneration for landed sandbox/variations files — the seam
 * that turns "a generated file landed" into the native entry-css hot-update
 * path (verified root cause: new files match no module-graph entry, so
 * neither Vite nor @tailwindcss/vite reacts and the entry css stays stale).
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createGeneratedTailwindRefresh,
  findTailwindEntryCssFiles,
  generatedTailwindDirs,
  isGeneratedTailwindSourceFile,
  wireGeneratedTailwindRefresh,
  type TailwindRefreshServer,
} from "./generatedTailwindRefresh.ts";

const APP = "/repo/examples/demo";

function fakeServer(files: Record<string, string | undefined>) {
  const watcher = new EventEmitter();
  const added: unknown[] = [];
  const emitted: Array<[string, string]> = [];
  const server: TailwindRefreshServer = {
    moduleGraph: {
      fileToModulesMap: new Map(Object.keys(files).map((f) => [f, new Set()])),
    },
    watcher: {
      add: (paths) => added.push(paths),
      on: (event, listener) => watcher.on(event, listener),
      off: (event, listener) => watcher.off(event, listener),
      emit: (event, ...args) => {
        emitted.push([event as string, args[0] as string]);
        return watcher.emit(event as string, ...args);
      },
    },
  };
  const readCss = (file: string) => files[file];
  return { server, watcher, added, emitted, readCss };
}

describe("isGeneratedTailwindSourceFile", () => {
  it("matches files under .designbook/sandbox and .designbook/variations", () => {
    expect(
      isGeneratedTailwindSourceFile(
        `${APP}/.designbook/sandbox/pin-1/variant.tsx`,
        APP,
      ),
    ).toBe(true);
    expect(
      isGeneratedTailwindSourceFile(
        `${APP}/.designbook/sandbox/pin-1/wrapper.tsx`,
        APP,
      ),
    ).toBe(true);
    expect(
      isGeneratedTailwindSourceFile(
        `${APP}/.designbook/variations/card/hero.tsx`,
        APP,
      ),
    ).toBe(true);
  });

  it("excludes the durable index records (rewritten per canvas drag)", () => {
    expect(
      isGeneratedTailwindSourceFile(`${APP}/.designbook/sandbox/index.ts`, APP),
    ).toBe(false);
    expect(
      isGeneratedTailwindSourceFile(
        `${APP}/.designbook/variations/index.ts`,
        APP,
      ),
    ).toBe(false);
  });

  it("excludes the sandbox overrides dir (O1 shims/runtime carry no markup)", () => {
    expect(
      isGeneratedTailwindSourceFile(
        `${APP}/.designbook/sandbox/overrides/src/Card.tsx`,
        APP,
      ),
    ).toBe(false);
    expect(
      isGeneratedTailwindSourceFile(
        `${APP}/.designbook/sandbox/overrides/_runtime.ts`,
        APP,
      ),
    ).toBe(false);
  });

  it("ignores adapter-managed and app files (suppression regression guard)", () => {
    for (const file of [
      `${APP}/locales/en-US/app.json`,
      `${APP}/src/themes.json`,
      `${APP}/src/index.css`,
      `${APP}/.designbook/worktrees/branch/src/App.tsx`,
      `${APP}/.designbook/figma/product.json`,
      `/elsewhere/.designbook-sandbox/x.tsx`,
    ]) {
      expect(isGeneratedTailwindSourceFile(file, APP)).toBe(false);
    }
  });
});

describe("findTailwindEntryCssFiles", () => {
  it("selects only css files that import tailwindcss v4", () => {
    const files = {
      [`${APP}/src/index.css`]: '@import "tailwindcss";\n@source "./";',
      [`${APP}/src/plain.css`]: ".a { color: red }",
      [`${APP}/src/App.tsx`]: 'import "./index.css";',
      // Unreadable (virtual/deleted) css must not throw or match.
      [`${APP}/src/gone.css`]: undefined,
    };
    expect(
      findTailwindEntryCssFiles(Object.keys(files), (f) => files[f]),
    ).toEqual([`${APP}/src/index.css`]);
  });
});

describe("createGeneratedTailwindRefresh", () => {
  const cssFiles = {
    [`${APP}/src/index.css`]: '@import "tailwindcss";',
    [`${APP}/src/plain.css`]: ".a{}",
  };

  it("sandbox write → emits a change for the tailwind entry css (debounced)", async () => {
    vi.useFakeTimers();
    try {
      const { server, emitted, readCss } = fakeServer(cssFiles);
      const refresh = createGeneratedTailwindRefresh({
        server,
        appRoot: APP,
        readCss,
      });
      refresh.handleWatchEvent(`${APP}/.designbook/sandbox/pin-1/variant.tsx`);
      refresh.handleWatchEvent(`${APP}/.designbook/sandbox/pin-1/wrapper.tsx`);
      expect(emitted).toEqual([]); // debounced, nothing yet
      await vi.runAllTimersAsync();
      // ONE coalesced refresh, only for the tailwind entry.
      expect(emitted).toEqual([["change", `${APP}/src/index.css`]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adapter/app writes → no refresh (stays suppressed elsewhere)", async () => {
    vi.useFakeTimers();
    try {
      const { server, emitted, readCss } = fakeServer(cssFiles);
      const refresh = createGeneratedTailwindRefresh({
        server,
        appRoot: APP,
        readCss,
      });
      refresh.handleWatchEvent(`${APP}/locales/en-US/app.json`);
      refresh.handleWatchEvent(`${APP}/src/themes.json`);
      refresh.handleWatchEvent(`${APP}/.designbook/sandbox/index.ts`);
      await vi.runAllTimersAsync();
      expect(emitted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush is immediate and returns the refreshed entries", () => {
    const { server, emitted, readCss } = fakeServer(cssFiles);
    const refresh = createGeneratedTailwindRefresh({
      server,
      appRoot: APP,
      readCss,
    });
    expect(refresh.flush()).toEqual([`${APP}/src/index.css`]);
    expect(emitted).toEqual([["change", `${APP}/src/index.css`]]);
  });

  it("dispose cancels a pending refresh", async () => {
    vi.useFakeTimers();
    try {
      const { server, emitted, readCss } = fakeServer(cssFiles);
      const refresh = createGeneratedTailwindRefresh({
        server,
        appRoot: APP,
        readCss,
      });
      refresh.handleWatchEvent(`${APP}/.designbook/sandbox/pin-1/variant.tsx`);
      refresh.dispose();
      await vi.runAllTimersAsync();
      expect(emitted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wireGeneratedTailwindRefresh", () => {
  it("watches the generated dirs and reacts to watcher add/change", async () => {
    vi.useFakeTimers();
    try {
      const { server, watcher, added, emitted, readCss } = fakeServer({
        [`${APP}/src/index.css`]: '@import "tailwindcss";',
      });
      const refresh = wireGeneratedTailwindRefresh(server, APP, { readCss });
      expect(added).toEqual([generatedTailwindDirs(APP)]);

      watcher.emit("add", `${APP}/.designbook/sandbox/pin-1/variant.tsx`);
      await vi.runAllTimersAsync();
      expect(emitted).toEqual([["change", `${APP}/src/index.css`]]);

      // The refresh's own synthetic css change must not re-trigger itself.
      await vi.runAllTimersAsync();
      expect(emitted).toHaveLength(1);

      // change events count too (post-restart / not-yet-scanned files).
      watcher.emit("change", `${APP}/.designbook/variations/card/hero.tsx`);
      await vi.runAllTimersAsync();
      expect(emitted).toHaveLength(2);

      refresh.dispose();
      watcher.emit("add", `${APP}/.designbook/sandbox/pin-2/variant.tsx`);
      await vi.runAllTimersAsync();
      expect(emitted).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
