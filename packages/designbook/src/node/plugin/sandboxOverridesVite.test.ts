/**
 * The vite ModuleOverrideHost adapter: serve-only gating, resolveId redirect
 * + bypass behavior, the production/build proof (dev-only hard gate), and
 * the generated-file full-reload guard (pre-ordered hotUpdate filter — the
 * invariant that a sandbox write can never surface an unknown/unreferenced
 * module change to @tailwindcss/vite or vite core's propagation).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import { createSandboxOverridesVite } from "./sandboxOverridesVite.ts";

/** Invoke the plugin's config hook the way vite does. */
function configure(plugin: Plugin, command: string, isProduction: boolean) {
  const hook = plugin.config as unknown as (
    config: unknown,
    env: { command: string; mode: string; isProduction: boolean },
  ) => void;
  hook.call(undefined, {}, {
    command,
    mode: isProduction ? "production" : "development",
    isProduction,
  });
}

/** Invoke resolveId with a fake plugin context whose resolve() echoes ids.
 * `seenImporters` records the importer the plugin resolved with (the
 * layer-alt importer remap assertion). */
async function resolve(
  plugin: Plugin,
  id: string,
  resolveTo: string | undefined,
  options?: { importer?: string; seenImporters?: string[] },
): Promise<unknown> {
  const handler = (
    typeof plugin.resolveId === "function"
      ? plugin.resolveId
      : plugin.resolveId?.handler
  ) as (this: unknown, id: string, importer?: string, options?: unknown) => Promise<unknown>;
  return handler.call(
    {
      resolve: async (_id: string, importer?: string) => {
        options?.seenImporters?.push(importer ?? "");
        return resolveTo ? { id: resolveTo, external: false } : null;
      },
    },
    id,
    options?.importer ?? "/repo/src/App.tsx",
    {},
  );
}

describe("createSandboxOverridesVite", () => {
  it("is serve-only (apply: 'serve') — absent from production builds", () => {
    const { plugin } = createSandboxOverridesVite();
    expect(plugin.apply).toBe("serve");
    expect(plugin.name).toBe("designbook:sandbox-overrides");
    // vite 7 resolves specifiers before NORMAL-phase user plugins — the
    // redirect must hook the pre phase or it never sees an import at all.
    expect(plugin.enforce).toBe("pre");
  });

  it("redirects a mapped module during a dev serve", async () => {
    const { plugin, apply } = createSandboxOverridesVite();
    configure(plugin, "serve", false);
    apply({ "/repo/src/Card.tsx": "/repo/shim/Card.tsx" });
    expect(await resolve(plugin, "./Card", "/repo/src/Card.tsx")).toBe(
      "/repo/shim/Card.tsx",
    );
    expect(await resolve(plugin, "./Other", "/repo/src/Other.tsx")).toBe(
      undefined,
    );
  });

  it("DEV-ONLY GATE: a build/production pass never sees redirects, even with a populated table", async () => {
    const { plugin, apply } = createSandboxOverridesVite();
    configure(plugin, "build", true);
    apply({ "/repo/src/Card.tsx": "/repo/shim/Card.tsx" });
    expect(
      await resolve(plugin, "./Card", "/repo/src/Card.tsx"),
    ).toBeUndefined();
  });

  it("?db-original bypass resolves the REAL module (loop-proof)", async () => {
    const { plugin, apply } = createSandboxOverridesVite();
    configure(plugin, "serve", false);
    apply({ "/repo/src/Card.tsx": "/repo/shim/Card.tsx" });
    // The fake context resolves the stripped specifier to the real module —
    // the bypass branch must return it UNREDIRECTED.
    expect(
      await resolve(plugin, "./Card.tsx?db-original", "/repo/src/Card.tsx"),
    ).toBe("/repo/src/Card.tsx");
  });

  it("LAYER-ALT IMPORTER REMAP: an alternative's imports resolve as if from the real location (falls through the stack)", async () => {
    const { plugin, apply } = createSandboxOverridesVite();
    configure(plugin, "serve", false);
    apply({ "/repo/src/Card.tsx": "/repo/.designbook/changesets/cs-x/alts/v1/src/Card.tsx" });
    const seenImporters: string[] = [];
    // "./atoms" imported FROM the alt file resolves against the REAL dir
    // (the fake echoes the real atoms path) and, with no redirect covering
    // atoms, returns that real resolution — never the alt-relative path.
    const resolvedAtoms = await resolve(plugin, "./atoms", "/repo/src/atoms.tsx", {
      importer:
        "/repo/.designbook/changesets/cs-x/alts/v1/src/Card.tsx",
      seenImporters,
    });
    expect(seenImporters).toEqual(["/repo/src/Card.tsx"]);
    expect(resolvedAtoms).toBe("/repo/src/atoms.tsx");
    // An overridden sibling still redirects (topmost active layer wins).
    apply({
      "/repo/src/Card.tsx": "/repo/.designbook/changesets/cs-x/alts/v1/src/Card.tsx",
      "/repo/src/atoms.tsx": "/repo/.designbook/changesets/cs-x/alts/v1/src/atoms.tsx",
    });
    expect(
      await resolve(plugin, "./atoms", "/repo/src/atoms.tsx", {
        importer:
          "/repo/.designbook/changesets/cs-x/alts/v1/src/Card.tsx",
      }),
    ).toBe("/repo/.designbook/changesets/cs-x/alts/v1/src/atoms.tsx");
  });

  it("LAYER-ONLY NEW FILES: a relative import of a module that exists only in the layer resolves through the table", async () => {
    const { plugin, apply } = createSandboxOverridesVite();
    configure(plugin, "serve", false);
    apply({
      "/repo/src/New.tsx": "/repo/.designbook/changesets/cs-x/alts/v1/src/New.tsx",
    });
    // Normal resolution FAILS (resolveTo undefined → null): the candidate
    // probe matches the redirect table by the path a real file would have.
    expect(
      await resolve(plugin, "./New", undefined, {
        importer: "/repo/src/App.tsx",
      }),
    ).toBe("/repo/.designbook/changesets/cs-x/alts/v1/src/New.tsx");
  });
});

describe("generated-file full-reload guard (hotUpdate)", () => {
  const SANDBOX = "/repo/.designbook/sandbox";

  /** Minimal EnvironmentModuleNode shape the guard consults. */
  function moduleNode(overrides: {
    file: string;
    type?: "js" | "asset";
    id?: string | null;
    importers?: number;
    isSelfAccepting?: boolean;
  }) {
    return {
      file: overrides.file,
      type: overrides.type ?? "js",
      id: overrides.id === undefined ? overrides.file : overrides.id,
      importers: new Set(
        Array.from({ length: overrides.importers ?? 0 }, (_, i) => ({ i })),
      ),
      isSelfAccepting: overrides.isSelfAccepting ?? false,
    };
  }

  function runHotUpdate(
    plugin: Plugin,
    options: { type?: string; file: string; modules: unknown[] },
  ): { result: unknown; invalidated: unknown[] } {
    const hook = plugin.hotUpdate as {
      order?: string;
      handler: (this: unknown, ctx: unknown) => unknown;
    };
    const invalidated: unknown[] = [];
    const result = hook.handler.call(
      {
        environment: {
          moduleGraph: {
            invalidateModule: (mod: unknown) => invalidated.push(mod),
          },
        },
      },
      { type: options.type ?? "update", ...options },
    );
    return { result, invalidated };
  }

  function guardedPlugin(): Plugin {
    return createSandboxOverridesVite({ warmDirs: [SANDBOX] }).plugin;
  }

  it("is hook-level order 'pre' — outranks the app's plugin array order, so it ALWAYS filters before @tailwindcss/vite's hotUpdate", () => {
    const plugin = guardedPlugin();
    expect((plugin.hotUpdate as { order?: string }).order).toBe("pre");
  });

  it("leaves an UNKNOWN sandbox file change (no modules) native — nothing for tailwind or core propagation to escalate", () => {
    const { result, invalidated } = runHotUpdate(guardedPlugin(), {
      file: `${SANDBOX}/pin-1/edit.tsx`,
      modules: [],
    });
    expect(result).toBeUndefined(); // empty list already can't escalate
    expect(invalidated).toEqual([]);
  });

  it("swallows tailwind's ASSET-ONLY entry for a scanned sandbox file (its silent full-reload class)", () => {
    const file = `${SANDBOX}/pin-1/edit.tsx`;
    const { result, invalidated } = runHotUpdate(guardedPlugin(), {
      file,
      modules: [moduleNode({ file, type: "asset", id: null })],
    });
    expect(result).toEqual([]);
    expect(invalidated).toEqual([]); // asset entries are left to tailwind's own bookkeeping
  });

  it("swallows a warmed-but-UNREFERENCED module (core's dead-end 'page reload' class) and invalidates it for the next fetch", () => {
    const file = `${SANDBOX}/pin-1/edit.tsx`;
    const mod = moduleNode({ file, importers: 0, isSelfAccepting: false });
    const { result, invalidated } = runHotUpdate(guardedPlugin(), {
      file,
      modules: [mod],
    });
    expect(result).toEqual([]);
    expect(invalidated).toEqual([mod]);
  });

  it("leaves a REFERENCED sandbox module to the native js-update path (O1 flip stays hot)", () => {
    const file = `${SANDBOX}/pin-1/module/edit.tsx`;
    const { result, invalidated } = runHotUpdate(guardedPlugin(), {
      file,
      modules: [moduleNode({ file, importers: 1 })],
    });
    expect(result).toBeUndefined();
    expect(invalidated).toEqual([]);
  });

  it("leaves a SELF-ACCEPTING sandbox module native (react-refresh handles it)", () => {
    const file = `${SANDBOX}/pin-1/v1.tsx`;
    const { result } = runHotUpdate(guardedPlugin(), {
      file,
      modules: [moduleNode({ file, isSelfAccepting: true })],
    });
    expect(result).toBeUndefined();
  });

  it("a 'create' keeps REFERENCED foreign modules (resolve-retry propagates) but drops unreferenced junk", () => {
    const file = `${SANDBOX}/pin-1/edit.tsx`;
    const referenced = moduleNode({
      file: `${SANDBOX}/pin-1/wrapper.tsx`,
      importers: 1,
    });
    const junk = moduleNode({
      file: `${SANDBOX}/pin-2/edit.tsx`, // stale resolve-failed scaffold
      importers: 0,
      isSelfAccepting: false,
    });
    const { result, invalidated } = runHotUpdate(guardedPlugin(), {
      type: "create",
      file,
      modules: [referenced, junk],
    });
    expect(result).toEqual([referenced]);
    expect(invalidated).toEqual([junk]);
  });

  it("guards the sibling durable index (.designbook/sandbox-index.ts): a persist's create with dragged-in junk never reloads", () => {
    const junk = moduleNode({
      file: `${SANDBOX}/pin-1/module/edit.tsx`,
      importers: 0,
      isSelfAccepting: false,
    });
    const { result, invalidated } = runHotUpdate(guardedPlugin(), {
      type: "create",
      file: "/repo/.designbook/sandbox-index.ts",
      modules: [junk],
    });
    expect(result).toEqual([]);
    expect(invalidated).toEqual([junk]);
  });

  it("ignores files outside the sandbox home", () => {
    const plugin = guardedPlugin();
    expect(
      runHotUpdate(plugin, { file: "/repo/src/App.tsx", modules: [] }).result,
    ).toBeUndefined();
  });

  it("guards 'delete' too: a failed ask's scaffold rm with a stale warmed module must not dead-end into a reload", () => {
    const file = `${SANDBOX}/pin-1/edit.tsx`;
    const mod = moduleNode({ file, importers: 0, isSelfAccepting: false });
    const { result, invalidated } = runHotUpdate(guardedPlugin(), {
      type: "delete",
      file,
      modules: [mod],
    });
    expect(result).toEqual([]);
    expect(invalidated).toEqual([mod]);
  });

  it("leaves the delete of a REFERENCED sandbox module native (discard flows keep vite's own semantics)", () => {
    const file = `${SANDBOX}/pin-1/v1.tsx`;
    const { result } = runHotUpdate(guardedPlugin(), {
      type: "delete",
      file,
      modules: [moduleNode({ file, importers: 1 })],
    });
    expect(result).toBeUndefined();
  });

  it("does nothing when no warmDirs are configured", () => {
    const { plugin } = createSandboxOverridesVite();
    const { result } = runHotUpdate(plugin, {
      file: `${SANDBOX}/pin-1/edit.tsx`,
      modules: [],
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HTTP-data redirect middleware (L2 follow-up of the L1 deferred note): data
// files fetched over HTTP bypass the module graph — the middleware serves
// the redirect target for mapped root/publicDir data paths.
// ---------------------------------------------------------------------------

describe("HTTP-data redirect middleware", () => {
  type Middleware = (
    req: { method: string; url?: string },
    res: {
      headers: Record<string, string>;
      body?: unknown;
      setHeader: (name: string, value: string) => void;
      end: (body?: unknown) => void;
    },
    next: () => void,
  ) => void;

  async function servedThrough(options: {
    redirects: Record<string, string>;
    url: string;
    method?: string;
    publicDir?: string | false;
  }): Promise<{ nexted: boolean; body?: string; headers: Record<string, string> }> {
    const { plugin, apply } = createSandboxOverridesVite();
    configure(plugin, "serve", false);
    let middleware: Middleware | undefined;
    const configureServer = (
      typeof plugin.configureServer === "function"
        ? plugin.configureServer
        : plugin.configureServer?.handler
    ) as (server: unknown) => void;
    configureServer.call(undefined, {
      config: {
        root: "/repo",
        publicDir: options.publicDir === false ? "" : (options.publicDir ?? "/repo/public"),
      },
      middlewares: {
        use: (fn: Middleware) => {
          middleware = fn;
        },
      },
      watcher: { on() {}, off() {} },
      httpServer: { once() {} },
      moduleGraph: { getModulesByFile: () => undefined },
    });
    apply(options.redirects);
    let nexted = false;
    const res = {
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
      end(body?: unknown) {
        this.body = body;
      },
    };
    let settled: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const origEnd = res.end.bind(res);
    res.end = (body?: unknown) => {
      origEnd(body);
      settled!();
    };
    middleware!(
      { method: options.method ?? "GET", url: options.url },
      res,
      () => {
        nexted = true;
        settled!();
      },
    );
    await done;
    return {
      nexted,
      body: res.body === undefined ? undefined : String(res.body),
      headers: res.headers,
    };
  }

  it("serves the redirect target for a mapped ROOT-relative data path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "db-httpdata-"));
    try {
      const alt = join(dir, "merged.json");
      await writeFile(alt, '{"merged":true}', "utf8");
      const out = await servedThrough({
        redirects: { "/repo/locales/en-US/app.json": alt },
        url: "/locales/en-US/app.json?v=1",
      });
      expect(out.nexted).toBe(false);
      expect(out.body).toBe('{"merged":true}');
      expect(out.headers["Content-Type"]).toBe("application/json");
      expect(out.headers["Cache-Control"]).toBe("no-store");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves a PUBLIC-DIR mapped path too, and passes everything else through", async () => {
    const dir = await mkdtemp(join(tmpdir(), "db-httpdata-"));
    try {
      const alt = join(dir, "merged.json");
      await writeFile(alt, '{"pub":1}', "utf8");
      const served = await servedThrough({
        redirects: { "/repo/public/locales/en.json": alt },
        url: "/locales/en.json",
      });
      expect(served.nexted).toBe(false);
      expect(served.body).toBe('{"pub":1}');
      // Unmapped path → next(); non-data extension → next(); POST → next().
      for (const options of [
        { redirects: { "/repo/x.json": alt }, url: "/other.json" },
        { redirects: { "/repo/a.tsx": alt }, url: "/a.tsx" },
        { redirects: { "/repo/x.json": alt }, url: "/x.json", method: "POST" },
        // Traversal never consults the table.
        { redirects: { "/repo/x.json": alt }, url: "/../x.json" },
        // MODULE-GRAPH requests flow to the transform pipeline (the
        // resolveId redirect covers them) — never intercepted here.
        { redirects: { "/repo/x.json": alt }, url: "/x.json?import" },
        { redirects: { "/repo/x.json": alt }, url: "/x.json?direct&t=1" },
        // CSS is module-imported entry css — never served raw from here
        // (live-run finding: raw tailwind source broke the css hot reload).
        { redirects: { "/repo/src/index.css": alt }, url: "/src/index.css" },
      ]) {
        expect((await servedThrough(options)).nexted).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a missing redirect target degrades to next() (vite serves the real file)", async () => {
    const out = await servedThrough({
      redirects: { "/repo/locales/en.json": "/nope/gone.json" },
      url: "/locales/en.json",
    });
    expect(out.nexted).toBe(true);
  });
});
