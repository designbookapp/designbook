import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseComponentsDir,
  detectIndent,
  detectPackageManagerFrom,
  globForDir,
  mergeScripts,
  pmAddDev,
  pmRun,
  renderConfigTemplate,
  renderViteVariant,
  runInit,
  titleFromPackageName,
  variantExtFor,
} from "./init.ts";

describe("detectPackageManagerFrom", () => {
  it("prefers pnpm > yarn > bun > npm by lockfile", () => {
    expect(detectPackageManagerFrom(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManagerFrom(["yarn.lock"])).toBe("yarn");
    expect(detectPackageManagerFrom(["bun.lockb"])).toBe("bun");
    expect(detectPackageManagerFrom(["bun.lock"])).toBe("bun");
    expect(detectPackageManagerFrom(["package-lock.json"])).toBe("npm");
    expect(detectPackageManagerFrom([])).toBe("npm");
  });
  it("pnpm wins when several lockfiles coexist", () => {
    expect(
      detectPackageManagerFrom(["package-lock.json", "pnpm-lock.yaml"]),
    ).toBe("pnpm");
  });
});

describe("pmRun / pmAddDev", () => {
  it("maps run prefixes", () => {
    expect(pmRun("npm")).toBe("npm run");
    expect(pmRun("pnpm")).toBe("pnpm");
    expect(pmRun("yarn")).toBe("yarn");
    expect(pmRun("bun")).toBe("bun run");
  });
  it("maps add-dev commands", () => {
    expect(pmAddDev("npm")).toBe("npm i -D");
    expect(pmAddDev("pnpm")).toBe("pnpm add -D");
    expect(pmAddDev("yarn")).toBe("yarn add -D");
    expect(pmAddDev("bun")).toBe("bun add -d");
  });
});

describe("variantExtFor", () => {
  it("matches the variant extension to the app's vite config", () => {
    expect(variantExtFor("vite.config.ts")).toBe("ts");
    expect(variantExtFor("vite.config.mts")).toBe("mts");
    expect(variantExtFor("vite.config.js")).toBe("js");
    expect(variantExtFor("vite.config.mjs")).toBe("mjs");
    expect(variantExtFor("vite.config.cts")).toBe("cts");
  });
});

describe("titleFromPackageName", () => {
  it("title-cases and strips scope", () => {
    expect(titleFromPackageName("client-app")).toBe("Client App");
    expect(titleFromPackageName("@scope/my-ui")).toBe("My Ui");
    expect(titleFromPackageName("myapp")).toBe("Myapp");
    expect(titleFromPackageName(undefined)).toBe("My App");
    expect(titleFromPackageName("")).toBe("My App");
  });
});

describe("globForDir", () => {
  it("builds a glob relative to .designbook/ (extra ../)", () => {
    expect(globForDir("src/components")).toBe("../src/components/*.tsx");
    expect(globForDir("src/components/")).toBe("../src/components/*.tsx");
    expect(globForDir("components")).toBe("../components/*.tsx");
  });
});

describe("chooseComponentsDir", () => {
  const preferred = ["src/components", "src/ui", "components", "src"];
  it("prefers src/components when it has files", () => {
    expect(
      chooseComponentsDir(
        [
          { dir: "src/components", componentFiles: 2 },
          { dir: "src/widgets", componentFiles: 9 },
        ],
        preferred,
      ),
    ).toBe("src/components");
  });
  it("falls through preferred order to src/ui", () => {
    expect(
      chooseComponentsDir(
        [{ dir: "src/ui", componentFiles: 3 }],
        preferred,
      ),
    ).toBe("src/ui");
  });
  it("otherwise picks the dir with the most component files", () => {
    expect(
      chooseComponentsDir(
        [
          { dir: "src/a", componentFiles: 2 },
          { dir: "src/b/widgets", componentFiles: 5 },
        ],
        preferred,
      ),
    ).toBe("src/b/widgets");
  });
  it("returns undefined when nothing has component files", () => {
    expect(
      chooseComponentsDir([{ dir: "src", componentFiles: 0 }], preferred),
    ).toBeUndefined();
  });
});

describe("detectIndent", () => {
  it("detects 2-space, 4-space, and tab indents", () => {
    expect(detectIndent('{\n  "a": 1\n}')).toBe("  ");
    expect(detectIndent('{\n    "a": 1\n}')).toBe("    ");
    expect(detectIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectIndent("{}")).toBe("  ");
  });
});

describe("mergeScripts", () => {
  const additions = {
    "dev:designbook": "vite --config vite.designbook.config.ts --port 3013",
    design: "designbook dev --port 8787",
  };
  it("adds missing scripts", () => {
    const r = mergeScripts({ scripts: { dev: "vite" } }, additions, false);
    expect(r.added.sort()).toEqual(["design", "dev:designbook"]);
    expect((r.pkg.scripts as Record<string, string>).dev).toBe("vite");
    expect((r.pkg.scripts as Record<string, string>).design).toBe(
      additions.design,
    );
  });
  it("skips scripts already exactly right", () => {
    const r = mergeScripts({ scripts: { ...additions } }, additions, false);
    expect(r.added).toEqual([]);
    expect(r.skipped.sort()).toEqual(["design", "dev:designbook"]);
  });
  it("flags conflicts without --force, preserving the user's value", () => {
    const r = mergeScripts(
      { scripts: { design: "my own thing" } },
      additions,
      false,
    );
    expect(r.conflicts).toEqual(["design"]);
    expect((r.pkg.scripts as Record<string, string>).design).toBe(
      "my own thing",
    );
    expect(r.added).toEqual(["dev:designbook"]);
  });
  it("overwrites conflicts with --force", () => {
    const r = mergeScripts(
      { scripts: { design: "my own thing" } },
      additions,
      true,
    );
    expect(r.conflicts).toEqual([]);
    expect((r.pkg.scripts as Record<string, string>).design).toBe(
      additions.design,
    );
  });
  it("handles a package with no scripts block", () => {
    const r = mergeScripts({ name: "x" }, additions, false);
    expect(Object.keys(r.pkg.scripts as object).sort()).toEqual([
      "design",
      "dev:designbook",
    ]);
  });
});

describe("renderConfigTemplate", () => {
  it("uses fromGlob with the detected glob and OMITS sourceModules", () => {
    const out = renderConfigTemplate({
      title: "Client App",
      glob: "./src/components/*.tsx",
    });
    expect(out).toContain('import { defineConfig, fromGlob } from "@designbookapp/designbook/config"');
    expect(out).toContain('title: "Client App"');
    expect(out).toContain('fromGlob(import.meta.glob("./src/components/*.tsx"))');
    expect(out).not.toContain("sourceModules");
  });
});

describe("runInit → .designbook/ template", () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-init-"));
    cwd = process.cwd();
    process.chdir(dir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes .designbook/config.tsx with a ../-relative glob", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "web", scripts: { dev: "vite" } }, null, 2),
    );
    writeFileSync(join(dir, "vite.config.ts"), "export default {};\n");
    mkdirSync(join(dir, "src/components"), { recursive: true });
    writeFileSync(
      join(dir, "src/components/Button.tsx"),
      "export function Button() { return null; }\n",
    );

    await runInit([]);

    const config = readFileSync(join(dir, ".designbook/config.tsx"), "utf8");
    expect(config).toContain(
      'fromGlob(import.meta.glob("../src/components/*.tsx"))',
    );

    const variant = readFileSync(join(dir, "vite.designbook.config.ts"), "utf8");
    expect(variant).toContain('config: "./.designbook/config.tsx"');

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.design).toContain("designbook dev");
    expect(pkg.scripts["dev:designbook"]).toContain("vite.designbook.config.ts");
  });
});

describe("renderViteVariant", () => {
  it("wraps the base config, drops checker, sets serverUrl to the sidecar", () => {
    const out = renderViteVariant({
      baseImport: "./vite.config",
      sidecarPort: 8793,
    });
    expect(out).toContain('import baseConfig from "./vite.config"');
    expect(out).toContain('designbookPlugin(');
    expect(out).toContain('config: "./.designbook/config.tsx"');
    expect(out).toContain('serverUrl: "http://localhost:8793"');
    expect(out).toContain('.includes("checker")');
    expect(out).toContain("open: false");
  });
});
