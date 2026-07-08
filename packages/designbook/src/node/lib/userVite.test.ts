import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import {
  designbookBaseAliases,
  detectNextDep,
  detectNextDepSource,
  detectTailwindInPostcss,
  filterInheritedPlugins,
  flattenPlugins,
  hasDependencyInWorkspaceMembers,
  mergeOptimizeDeps,
  normalizeAlias,
  orderedSearchDirs,
  pickAutoDetectConfigDirs,
  pluginDenyReason,
  resolveUserVite,
  synthesizeSourceAliases,
  workspaceDepDirs,
  workspaceGlobParents,
} from "./userVite";

const p = (name: string): Plugin => ({ name }) as Plugin;

describe("normalizeAlias", () => {
  it("converts object form to array entries", () => {
    expect(normalizeAlias({ alias: { "@a": "/a", "@b": "/b" } })).toEqual([
      { find: "@a", replacement: "/a" },
      { find: "@b", replacement: "/b" },
    ]);
  });

  it("passes array form through, preserving regex + customResolver", () => {
    const resolver = () => null;
    const arr = [{ find: /^@x(\/.*)?$/, replacement: "/x$1", customResolver: resolver }];
    expect(normalizeAlias({ alias: arr })).toEqual(arr);
  });

  it("returns [] for missing alias", () => {
    expect(normalizeAlias(undefined)).toEqual([]);
    expect(normalizeAlias({})).toEqual([]);
  });
});

describe("mergeOptimizeDeps", () => {
  it("unions and de-dups include/exclude", () => {
    const merged = mergeOptimizeDeps(
      { include: ["a", "b"], exclude: ["x"] },
      { include: ["b", "c"], exclude: ["y"] },
    );
    expect(merged.include).toEqual(["a", "b", "c"]);
    expect(merged.exclude).toEqual(["x", "y"]);
  });

  it("returns {} when both empty", () => {
    expect(mergeOptimizeDeps(undefined, undefined)).toEqual({});
  });
});

describe("orderedSearchDirs", () => {
  it("orders configDir, projectRoot, apps/*, packages/*, */ and de-dups", () => {
    const listSubdirs = (dir: string) => {
      if (dir.endsWith("/apps")) return ["web"];
      if (dir.endsWith("/packages")) return ["ui"];
      if (dir === "/repo") return ["apps", "packages", "excalidraw-app"];
      return [];
    };
    const dirs = orderedSearchDirs("/repo/design", "/repo", listSubdirs);
    expect(dirs).toEqual([
      "/repo/design",
      "/repo",
      "/repo/apps/web",
      "/repo/packages/ui",
      "/repo/apps",
      "/repo/packages",
      "/repo/excalidraw-app",
    ]);
  });
});

describe("designbookBaseAliases", () => {
  it("reserves @designbook-ui first", () => {
    const aliases = designbookBaseAliases({ uiRoot: "/pkg/src/ui", packageRoot: "/pkg" });
    expect(aliases[0]).toEqual({ find: "@designbook-ui", replacement: "/pkg/src/ui" });
    expect(aliases.map((a) => a.find)).toEqual([
      "@designbook-ui",
      "@designbookapp/designbook/config",
      "@designbookapp/designbook/adapters",
    ]);
  });
});

describe("detectNextDep", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-next-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("true when next is a dependency", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "14" } }));
    expect(detectNextDep(dir)).toBe(true);
  });

  it("false when next is only hoisted into node_modules, not declared (fix: next false positive)", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    mkdirSync(join(dir, "node_modules/next"), { recursive: true });
    writeFileSync(join(dir, "node_modules/next/package.json"), "{}");
    expect(detectNextDep(dir)).toBe(false);
  });

  it("false with no next", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "19" } }));
    expect(detectNextDep(dir)).toBe(false);
  });

  it("true when next is declared only in a workspace member (e.g. apps/web), not the config's own chain", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    writeFileSync(
      join(dir, "apps/web/package.json"),
      JSON.stringify({ dependencies: { next: "14" } }),
    );
    expect(detectNextDep(dir)).toBe(true);
  });
});

describe("detectNextDepSource", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-next-src-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names the config's own package.json when next is a direct dependency", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "14" } }));
    expect(detectNextDepSource(dir)).toBe(join(dir, "package.json"));
  });

  it("names the workspace-member package.json that triggered detection (traceable logging)", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    writeFileSync(
      join(dir, "apps/web/package.json"),
      JSON.stringify({ dependencies: { next: "14" } }),
    );
    expect(detectNextDepSource(dir)).toBe(join(dir, "apps/web/package.json"));
  });

  it("undefined when next is not found anywhere", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    expect(detectNextDepSource(dir)).toBeUndefined();
  });
});

describe("resolveUserVite", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-uv-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("orders base < sidecar < auto-detected, appends only sidecar plugins", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");
    writeFileSync(
      join(dir, "designbook.vite.mjs"),
      `export default {
        resolve: { alias: { "@sidecar": "/s" }, dedupe: ["lodash"] },
        define: { FOO: "1" },
        plugins: [{ name: "sidecar-plugin" }],
      };`,
    );
    writeFileSync(
      join(dir, "vite.config.mjs"),
      `export default {
        resolve: { alias: { "@auto": "/a" } },
        define: { BAR: "2" },
        plugins: [{ name: "framework-plugin" }],
      };`,
    );

    const merge = await resolveUserVite({
      configPath: join(dir, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot: "/pkg/src/ui",
      packageRoot: "/pkg",
    });

    expect(merge.alias.map((a) => a.find)).toEqual([
      "@designbook-ui",
      "@designbookapp/designbook/config",
      "@designbookapp/designbook/adapters",
      "@sidecar",
      "@auto",
    ]);
    // Only the sidecar plugin is merged; the repo's own plugins are dropped.
    expect(merge.plugins).toEqual([[{ name: "sidecar-plugin" }]]);
    expect(merge.define).toEqual({ BAR: "2", FOO: "1" });
    expect(merge.dedupe).toContain("lodash");
    expect(merge.sidecarPath).toContain("designbook.vite.mjs");
    expect(merge.autoDetectedPath).toContain("vite.config.mjs");
    expect(merge.nextShimIds).toEqual([]);
  });

  it("appends next shims last when next is a dependency", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "14" } }));
    writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");

    const uiRoot = join(dir, "ui");
    mkdirSync(join(uiRoot, "shims/next"), { recursive: true });
    for (const f of ["link", "navigation", "image", "dynamic"]) {
      writeFileSync(join(uiRoot, "shims/next", `${f}.tsx`), "export default null;");
    }

    const merge = await resolveUserVite({
      configPath: join(dir, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot,
      packageRoot: dir,
    });

    expect(merge.nextShimIds).toEqual([
      "next/link",
      "next/navigation",
      "next/image",
      "next/dynamic",
    ]);
    const finds = merge.alias.map((a) => a.find);
    expect(finds.slice(-4)).toEqual([
      "next/link",
      "next/navigation",
      "next/image",
      "next/dynamic",
    ]);
  });

  it("logs which package.json triggered next-detection (honest/traceable, no behavior change)", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    writeFileSync(
      join(dir, "apps/web/package.json"),
      JSON.stringify({ dependencies: { next: "14" } }),
    );
    writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");

    const uiRoot = join(dir, "ui");
    mkdirSync(join(uiRoot, "shims/next"), { recursive: true });
    for (const f of ["link", "navigation", "image", "dynamic"]) {
      writeFileSync(join(uiRoot, "shims/next", `${f}.tsx`), "export default null;");
    }

    const logs: string[] = [];
    await resolveUserVite({
      configPath: join(dir, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot,
      packageRoot: dir,
      log: (msg) => logs.push(msg),
    });

    expect(logs).toContainEqual(
      "[designbook] next dependency found (apps/web/package.json) — registering fallback next/* shim aliases (lowest precedence)",
    );
  });

  it("strips css.postcss from an auto-detected config but flags it for tailwind detection (fixes: css.postcss poisoning + tailwind-scope-miss)", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");
    writeFileSync(
      join(dir, "vite.config.mjs"),
      `function tailwindcss() {}
      export default {
        css: {
          postcss: { plugins: [tailwindcss] },
          preprocessorOptions: { scss: { api: "modern" } },
        },
      };`,
    );

    const merge = await resolveUserVite({
      configPath: join(dir, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot: "/pkg/src/ui",
      packageRoot: "/pkg",
    });

    // postcss dropped from the merged css (would poison our own v4 pipeline)...
    expect(merge.css).toEqual({ preprocessorOptions: { scss: { api: "modern" } } });
    // ...but still detected as a tailwind signal.
    expect(merge.autoDetectedPostcssTailwind).toBe(true);
  });

  it("drops unresolvable auto-detected optimizeDeps.include entries, keeps resolvable ones", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");
    writeFileSync(
      join(dir, "vite.config.mjs"),
      `export default {
        optimizeDeps: { include: ["vite", "this-package-does-not-exist-anywhere"] },
      };`,
    );

    const merge = await resolveUserVite({
      configPath: join(dir, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot: "/pkg/src/ui",
      packageRoot: "/pkg",
    });

    // "vite" resolves from designbook's own root; the bogus one doesn't and is dropped.
    expect(merge.optimizeDeps.include).toContain("vite");
    expect(merge.optimizeDeps.include).not.toContain("this-package-does-not-exist-anywhere");
  });

  it("keeps an include entry resolvable from packageRoot even when unresolvable from configDir/projectRoot (fix: optimizeDeps filter root)", async () => {
    // Simulates documenso: the auto-detected config's own dir can resolve a
    // dep (e.g. via its node_modules) that designbook's embedded Vite never
    // sees, while a dep only present in designbook's packageRoot (vite itself)
    // must still be kept since that's a root Vite's optimizer actually uses.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");
    writeFileSync(
      join(dir, "vite.config.mjs"),
      `export default {
        optimizeDeps: { include: ["vite", "this-package-does-not-exist-anywhere"] },
      };`,
    );

    // packageRoot is a DIFFERENT dir than configDir/projectRoot here — proves
    // the filter checks packageRoot, not the detected config's own directory.
    const packageRoot = process.cwd();

    const merge = await resolveUserVite({
      configPath: join(dir, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot: "/pkg/src/ui",
      packageRoot,
    });

    // "vite" resolves from designbook's packageRoot (this package's own root).
    expect(merge.optimizeDeps.include).toContain("vite");
    expect(merge.optimizeDeps.include).not.toContain("this-package-does-not-exist-anywhere");
  });

  it("does not filter sidecar optimizeDeps.include (explicit user intent)", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");
    writeFileSync(
      join(dir, "designbook.vite.mjs"),
      `export default {
        optimizeDeps: { include: ["totally-made-up-sidecar-dep"] },
      };`,
    );

    const merge = await resolveUserVite({
      configPath: join(dir, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot: "/pkg/src/ui",
      packageRoot: "/pkg",
    });

    expect(merge.optimizeDeps.include).toContain("totally-made-up-sidecar-dep");
  });
});

describe("hasDependencyInWorkspaceMembers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-wsmember-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("true when a package one level under packages/* declares the dep", () => {
    mkdirSync(join(dir, "packages/tailwind-config"), { recursive: true });
    writeFileSync(
      join(dir, "packages/tailwind-config/package.json"),
      JSON.stringify({ devDependencies: { tailwindcss: "3" } }),
    );
    expect(hasDependencyInWorkspaceMembers("tailwindcss", dir)).toBe(true);
  });

  it("false when no workspace member declares the dep", () => {
    mkdirSync(join(dir, "packages/other"), { recursive: true });
    writeFileSync(join(dir, "packages/other/package.json"), JSON.stringify({}));
    expect(hasDependencyInWorkspaceMembers("tailwindcss", dir)).toBe(false);
  });
});

describe("workspaceGlobParents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-wsglob-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("always includes the apps/packages defaults", () => {
    expect(workspaceGlobParents(dir)).toEqual(expect.arrayContaining(["apps", "packages"]));
  });

  it("adds a package.json#workspaces `<dir>/*` glob entry", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["libs/*"] }));
    expect(workspaceGlobParents(dir)).toEqual(expect.arrayContaining(["apps", "packages", "libs"]));
  });

  it("adds a pnpm-workspace.yaml `<dir>/*` glob entry", () => {
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'tooling/*'\n");
    expect(workspaceGlobParents(dir)).toEqual(
      expect.arrayContaining(["apps", "packages", "tooling"]),
    );
  });
});

describe("detectTailwindInPostcss", () => {
  it("false when no postcss config", () => {
    expect(detectTailwindInPostcss(undefined)).toBe(false);
    expect(detectTailwindInPostcss({})).toBe(false);
  });

  it("true when a plugin's postcssPlugin name mentions tailwind (v3 style)", () => {
    expect(
      detectTailwindInPostcss({
        postcss: { plugins: [{ postcssPlugin: "tailwindcss" }] },
      }),
    ).toBe(true);
  });

  it("true when a bare plugin function is named tailwindcss", () => {
    function tailwindcss() {}
    expect(detectTailwindInPostcss({ postcss: { plugins: [tailwindcss] } })).toBe(true);
  });

  it("false for unrelated postcss plugins", () => {
    expect(
      detectTailwindInPostcss({
        postcss: { plugins: [{ postcssPlugin: "autoprefixer" }] },
      }),
    ).toBe(false);
  });
});

describe("pickAutoDetectConfigDirs (fix: wrong-package vite-config fallback)", () => {
  it("excalidraw layout: excalidraw-app (root-level, app-like, sole vite-config) is found", () => {
    const projectRoot = "/repo";
    const configDir = "/repo"; // designbook.config lives at repo root, no vite.config of its own
    const listSubdirs = (dir: string) => {
      if (dir === "/repo/apps") return [];
      if (dir === "/repo/packages") return ["excalidraw", "common", "math"];
      if (dir === "/repo") return ["excalidraw-app", "packages"];
      return [];
    };
    const pick = pickAutoDetectConfigDirs({
      configDir,
      projectRoot,
      listSubdirs,
      pkgNameOf: () => undefined,
      // Only excalidraw-app (a real dev app, not a published lib) ships a vite.config.
      hasViteConfig: (d) => d === "/repo/excalidraw-app",
      isAppPkg: (d) => d === "/repo/excalidraw-app",
      configPkgDeps: new Set(), // root package doesn't depend on the demo app
    });
    expect(pick.dirs).toContain("/repo/excalidraw-app");
    expect(pick.skipped).toEqual([]);
  });

  it("twenty layout: create-twenty-app (has main, a CLI/lib) NOT picked; the app-like twenty-front is", () => {
    const projectRoot = "/repo";
    const configDir = "/repo/packages/twenty-front"; // no vite.config test needed here, only picking
    const listSubdirs = (dir: string) => {
      if (dir === "/repo/packages") return ["create-twenty-app", "twenty-front", "twenty-ui"];
      if (dir === "/repo/apps") return [];
      if (dir === "/repo") return ["packages"];
      return [];
    };
    const pick = pickAutoDetectConfigDirs({
      configDir,
      projectRoot,
      listSubdirs,
      pkgNameOf: (d) =>
        ({
          "/repo/packages/create-twenty-app": "create-twenty-app",
          "/repo/packages/twenty-front": "twenty-front",
          "/repo/packages/twenty-ui": "twenty-ui",
        })[d],
      hasViteConfig: (d) =>
        d === "/repo/packages/create-twenty-app" || d === "/repo/packages/twenty-front",
      isAppPkg: (d) => d === "/repo/packages/twenty-front", // create-twenty-app has "main"/"bin"
      configPkgDeps: new Set(), // not declared as a dep — must be excluded via rule (b)
    });
    expect(pick.dirs).not.toContain("/repo/packages/create-twenty-app");
    expect(pick.dirs).toContain("/repo/packages/twenty-front");
    expect(pick.skipped).toEqual(["/repo/packages/create-twenty-app"]);
  });

  it("calcom layout: packages/embeds (a library, has exports) is NOT picked even as sole candidate", () => {
    const projectRoot = "/repo";
    const configDir = "/repo/apps/web";
    const listSubdirs = (dir: string) => {
      if (dir === "/repo/packages") return ["embeds"];
      if (dir === "/repo/apps") return ["web"];
      if (dir === "/repo") return ["apps", "packages"];
      return [];
    };
    const pick = pickAutoDetectConfigDirs({
      configDir,
      projectRoot,
      listSubdirs,
      pkgNameOf: (d) => (d === "/repo/packages/embeds" ? "@calcom/embeds" : undefined),
      hasViteConfig: (d) => d === "/repo/packages/embeds",
      isAppPkg: () => false, // embeds ships `main`/`exports` — a library, not an app
      configPkgDeps: new Set(),
    });
    expect(pick.dirs).not.toContain("/repo/packages/embeds");
    expect(pick.skipped).toEqual(["/repo/packages/embeds"]);
  });

  it("a workspace-dep candidate is preferred even over an app-like sole-candidate elsewhere", () => {
    const pick = pickAutoDetectConfigDirs({
      configDir: "/repo/design",
      projectRoot: "/repo",
      listSubdirs: (dir: string) => {
        if (dir === "/repo/packages") return ["ui-app", "dep-app"];
        return [];
      },
      pkgNameOf: (d) => ({ "/repo/packages/dep-app": "dep-app" })[d],
      hasViteConfig: () => true,
      isAppPkg: () => true,
      configPkgDeps: new Set(["dep-app"]),
    });
    // dep-app comes before the un-declared ui-app.
    expect(pick.dirs.indexOf("/repo/packages/dep-app")).toBeLessThan(
      pick.dirs.indexOf("/repo/packages/ui-app") === -1
        ? Infinity
        : pick.dirs.indexOf("/repo/packages/ui-app"),
    );
    expect(pick.dirs).toContain("/repo/packages/dep-app");
  });
});

describe("flattenPlugins", () => {
  it("awaits promises, flattens nested arrays, drops falsy holes", async () => {
    const flat = await flattenPlugins([
      p("a"),
      Promise.resolve(p("b")),
      [p("c"), [p("d")]],
      false,
      null,
      undefined,
      Promise.resolve(false),
    ]);
    expect(flat.map((x) => x.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns [] for undefined", async () => {
    expect(await flattenPlugins(undefined)).toEqual([]);
  });
});

describe("pluginDenyReason", () => {
  it("denies framework/server plugins by name (case-insensitive)", () => {
    for (const name of [
      "react-router",
      "react-router:virtual-modules",
      "react-router-server-change-trigger-client-hmr",
      "remix",
      "remix-hmr-runtime",
      "vite-plugin-sveltekit-setup",
      "astro:scripts",
      "@astrojs/vite-plugin-astro",
      "vite-plugin-qwik",
      "vite-plugin-pwa:info",
      "solid",
      "nitro:server",
      "vite:build-import-analysis",
    ]) {
      expect(pluginDenyReason(name)).toBeDefined();
    }
  });

  it("denies write-side-effect/codegen plugins (real names seen in production runs)", () => {
    for (const name of [
      "vite-plugin-sass-dts", // rewrote 95 .module.scss.d.ts files in twenty
      "vite-plugin-dts",
      "unplugin-dts", // what vite-plugin-dts@5+ registers under internally
      "vite:dts", // older vite-plugin-dts versions
    ]) {
      expect(pluginDenyReason(name)).toBeDefined();
    }
  });

  it("denies dev-tooling checker plugins (real name: vite-plugin-checker crashed excalidraw's server)", () => {
    for (const name of ["vite-plugin-checker", "vite-plugin-eslint", "stylelint-vite-plugin"]) {
      expect(pluginDenyReason(name)).toBeDefined();
    }
  });

  it("denies dev-server/middleware hijacker plugins (real name: @hono/vite-dev-server 404'd documenso's workbench)", () => {
    for (const name of ["@hono/vite-dev-server", "some-custom-dev-server"]) {
      expect(pluginDenyReason(name)).toBeDefined();
    }
  });

  it("does NOT deny plugins we want to inherit", () => {
    for (const name of [
      "vite-plugin-lingui-load-catalog",
      "vite-plugin-svgr",
      "unplugin-icons",
      "my-context-plugin", // 'next' must not match inside 'context'
      "consolidated-things", // 'solid' guarded
      "dtsGenerator", // 'dts' must not match inside a larger camelCase word
    ]) {
      expect(pluginDenyReason(name)).toBeUndefined();
    }
  });
});

describe("filterInheritedPlugins", () => {
  it("RR7 multi-plugin shape: all react-router plugins denied; lingui kept; react extracted", () => {
    const { react, kept, denied } = filterInheritedPlugins(
      [
        p("react-router"),
        p("react-router:virtual-modules"),
        p("react-router-server-change-trigger-client-hmr"),
        p("vite:react-babel"),
        p("vite:react-refresh"),
        p("vite-plugin-lingui-load-catalog"),
      ],
      new Set(),
    );
    expect(react.map((x) => x.name)).toEqual(["vite:react-babel", "vite:react-refresh"]);
    expect(kept.map((x) => x.name)).toEqual(["vite-plugin-lingui-load-catalog"]);
    expect(denied.map((d) => d.name)).toEqual([
      "react-router",
      "react-router:virtual-modules",
      "react-router-server-change-trigger-client-hmr",
    ]);
  });

  it("react dedupe — babel variant (incl. colon-form) extracted into react[]", () => {
    const { react } = filterInheritedPlugins(
      [
        p("vite:react-babel"),
        p("vite:react-refresh"),
        p("vite:react:config-post"),
        p("@vitejs/plugin-react-swc/preamble"),
      ],
      new Set(),
    );
    expect(react.map((x) => x.name)).toEqual([
      "vite:react-babel",
      "vite:react-refresh",
      "vite:react:config-post",
      "@vitejs/plugin-react-swc/preamble",
    ]);
  });

  it("react dedupe — swc variant extracted", () => {
    const { react, kept } = filterInheritedPlugins(
      [p("vite:react-swc"), p("vite:react-swc:resolve-runtime"), p("some-other")],
      new Set(),
    );
    expect(react.map((x) => x.name)).toEqual([
      "vite:react-swc",
      "vite:react-swc:resolve-runtime",
    ]);
    expect(kept.map((x) => x.name)).toEqual(["some-other"]);
  });

  it("none-inherited fallback: react[] empty ⇒ caller keeps its own react()", () => {
    const { react, kept } = filterInheritedPlugins([p("vite-plugin-svgr")], new Set());
    expect(react).toEqual([]);
    expect(kept.map((x) => x.name)).toEqual(["vite-plugin-svgr"]);
  });

  it("ours-vs-theirs collision: a user plugin whose name matches one of ours is dropped", () => {
    const ours = new Set(["vite-tsconfig-paths", "@tailwindcss/vite:scan"]);
    const { kept, denied } = filterInheritedPlugins(
      [p("vite-tsconfig-paths"), p("@tailwindcss/vite:scan"), p("keep-me")],
      ours,
    );
    expect(kept.map((x) => x.name)).toEqual(["keep-me"]);
    expect(denied).toEqual([
      { name: "vite-tsconfig-paths", reason: "collides with a designbook plugin" },
      { name: "@tailwindcss/vite:scan", reason: "collides with a designbook plugin" },
    ]);
  });

  it("react family is exempt from our-name collision (theirs wins even if we also add react)", () => {
    // Our react()'s own names in ourPluginNames must NOT drop the inherited react.
    const ours = new Set(["vite:react-babel", "vite:react-refresh"]);
    const { react, denied } = filterInheritedPlugins([p("vite:react-babel")], ours);
    expect(react.map((x) => x.name)).toEqual(["vite:react-babel"]);
    expect(denied).toEqual([]);
  });
});

describe("synthesizeSourceAliases", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-srcalias-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("skips when the dist target already exists (built)", () => {
    const pkg = join(dir, "twenty-ui");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "dist/index.js"), "");
    writeFileSync(join(pkg, "src/index.ts"), "");
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "twenty-ui", main: "./dist/index.js" }),
    );
    expect(synthesizeSourceAliases(pkg, "twenty-ui")).toEqual([]);
  });

  it("synthesizes exact + subpath regex aliases when dist is unbuilt but src exists", () => {
    const pkg = join(dir, "twenty-ui");
    mkdirSync(join(pkg, "src/navigation"), { recursive: true });
    writeFileSync(join(pkg, "src/index.tsx"), "");
    writeFileSync(join(pkg, "src/navigation/index.ts"), "");
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "twenty-ui", exports: { ".": "./dist/index.js" } }),
    );
    const aliases = synthesizeSourceAliases(pkg, "twenty-ui");
    expect(aliases).toHaveLength(2);

    const [exact, subpath] = aliases;
    expect(exact.replacement).toBe(join(pkg, "src/index.tsx"));
    // exact matches only the bare specifier
    expect((exact.find as RegExp).test("twenty-ui")).toBe(true);
    expect((exact.find as RegExp).test("twenty-ui/navigation")).toBe(false);
    // subpath maps twenty-ui/navigation -> <src>/navigation
    expect((subpath.find as RegExp).test("twenty-ui/navigation")).toBe(true);
    expect("twenty-ui/navigation".replace(subpath.find as RegExp, subpath.replacement as string)).toBe(
      join(pkg, "src/navigation"),
    );
  });

  it("returns [] when there is no src/ dir", () => {
    const pkg = join(dir, "lib");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "lib", main: "./dist/index.js" }));
    expect(synthesizeSourceAliases(pkg, "lib")).toEqual([]);
  });
});

describe("workspaceDepDirs", () => {
  it("returns member dirs whose package name is a direct dep", () => {
    const found = workspaceDepDirs({
      configPkgDeps: new Set(["twenty-ui"]),
      projectRoot: "/repo",
      parents: ["packages"],
      listSubdirs: (d) => (d === "/repo/packages" ? ["twenty-ui", "twenty-server"] : []),
      pkgNameOf: (d) =>
        ({ "/repo/packages/twenty-ui": "twenty-ui", "/repo/packages/twenty-server": "twenty-server" })[d],
    });
    expect(found).toEqual([{ dir: "/repo/packages/twenty-ui", name: "twenty-ui" }]);
  });
});

describe("resolveUserVite — inherited plugins + Item 8 css/aliases", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-uv2-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("captures the auto-detected repo config's plugins as inheritedPlugins (raw)", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");
    writeFileSync(
      join(dir, "vite.config.mjs"),
      `export default { plugins: [{ name: "framework-plugin" }, [{ name: "nested" }]] };`,
    );
    const merge = await resolveUserVite({
      configPath: join(dir, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot: "/pkg/src/ui",
      packageRoot: "/pkg",
    });
    const flat = await flattenPlugins(merge.inheritedPlugins);
    expect(flat.map((x) => x.name)).toEqual(["framework-plugin", "nested"]);
    // Sidecar-only channel stays empty.
    expect(merge.plugins).toEqual([]);
  });

  it("unions css preprocessorOptions from a workspace dep, primary wins on conflict (closest-wins)", async () => {
    // config's package (at root) depends on packages/dep-ui
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "dep-ui": "*" } }),
    );
    writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");
    writeFileSync(
      join(dir, "vite.config.mjs"),
      `export default { css: { preprocessorOptions: { scss: { api: "modern" } } } };`,
    );
    const depUi = join(dir, "packages/dep-ui");
    mkdirSync(depUi, { recursive: true });
    writeFileSync(join(depUi, "package.json"), JSON.stringify({ name: "dep-ui" }));
    writeFileSync(
      join(depUi, "vite.config.mjs"),
      `export default { css: { preprocessorOptions: { scss: { api: "legacy", includePaths: ["x"] } } } };`,
    );

    const merge = await resolveUserVite({
      configPath: join(dir, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot: "/pkg/src/ui",
      packageRoot: "/pkg",
    });
    expect(merge.css?.preprocessorOptions?.scss).toEqual({
      api: "modern", // primary (closest) wins
      includePaths: ["x"], // unioned in from the dep
    });
  });

  it("twenty shape: primary config fails to load, dep's css is still collected + source aliases synthesized", async () => {
    // configDir = packages/twenty-front (depends on twenty-ui)
    const front = join(dir, "packages/twenty-front");
    const ui = join(dir, "packages/twenty-ui");
    mkdirSync(front, { recursive: true });
    mkdirSync(join(ui, "src/navigation"), { recursive: true });
    writeFileSync(
      join(front, "package.json"),
      JSON.stringify({ name: "twenty-front", dependencies: { "twenty-ui": "*" } }),
    );
    writeFileSync(join(front, "designbook.config.tsx"), "export default {};");
    // primary config throws at load time
    writeFileSync(join(front, "vite.config.mjs"), `throw new Error("twenty-front config boom");`);
    // twenty-ui: unbuilt dist + src, loadable vite config with scss options
    writeFileSync(
      join(ui, "package.json"),
      JSON.stringify({ name: "twenty-ui", exports: { ".": "./dist/index.js" } }),
    );
    writeFileSync(join(ui, "src/index.ts"), "");
    writeFileSync(join(ui, "src/navigation/index.ts"), "");
    writeFileSync(
      join(ui, "vite.config.mjs"),
      `export default { css: { preprocessorOptions: { scss: { includePaths: ["ui"] } } } };`,
    );

    const merge = await resolveUserVite({
      configPath: join(front, "designbook.config.tsx"),
      projectRoot: dir,
      uiRoot: "/pkg/src/ui",
      packageRoot: "/pkg",
    });

    // dep css collected despite the primary throwing
    expect(merge.css?.preprocessorOptions?.scss).toEqual({ includePaths: ["ui"] });
    // source aliases synthesized for the unbuilt twenty-ui
    const exact = merge.alias.find(
      (a) => a.find instanceof RegExp && (a.find as RegExp).test("twenty-ui"),
    );
    expect(exact?.replacement).toBe(join(ui, "src/index.ts"));
    const subpath = merge.alias.find(
      (a) =>
        a.find instanceof RegExp &&
        (a.find as RegExp).test("twenty-ui/navigation") &&
        !(a.find as RegExp).test("twenty-ui"),
    );
    expect(subpath).toBeDefined();
  });
});

describe("resolveUserVite concurrency (fix: serialize vite-config loads)", () => {
  let dirs: string[];
  beforeEach(() => {
    dirs = Array.from({ length: 5 }, () => mkdtempSync(join(tmpdir(), "db-uv-mutex-")));
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("many concurrent resolveUserVite calls (sidecar + auto-detected + workspace-dep configs) all resolve correctly", async () => {
    // Concurrent loadConfigFromFile calls raced Node's ESM loader on twenty's
    // workspace-dep configs (ERR_INTERNAL_ASSERTION). This fires several
    // resolveUserVite calls at once, each touching multiple vite configs, as
    // a regression guard for the promise-chain mutex around loadViteFile.
    dirs.forEach((dir, i) => {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: `app-${i}`, dependencies: { [`dep-ui-${i}`]: "*" } }),
      );
      writeFileSync(join(dir, "designbook.config.tsx"), "export default {};");
      writeFileSync(
        join(dir, "designbook.vite.mjs"),
        `export default { define: { SIDECAR: ${i} } };`,
      );
      writeFileSync(
        join(dir, "vite.config.mjs"),
        `export default { define: { PRIMARY: ${i} } };`,
      );
      const depDir = join(dir, "packages", `dep-ui-${i}`);
      mkdirSync(depDir, { recursive: true });
      writeFileSync(join(depDir, "package.json"), JSON.stringify({ name: `dep-ui-${i}` }));
      writeFileSync(
        join(depDir, "vite.config.mjs"),
        `export default { css: { preprocessorOptions: { scss: { tag: "${i}" } } } };`,
      );
    });

    const merges = await Promise.all(
      dirs.map((dir, i) =>
        resolveUserVite({
          configPath: join(dir, "designbook.config.tsx"),
          projectRoot: dir,
          uiRoot: "/pkg/src/ui",
          packageRoot: "/pkg",
        }).then((merge) => ({ merge, i })),
      ),
    );

    for (const { merge, i } of merges) {
      expect(merge.define).toEqual({ PRIMARY: i, SIDECAR: i });
      expect(merge.css?.preprocessorOptions?.scss).toEqual({ tag: `${i}` });
    }
  });
});
