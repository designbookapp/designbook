/**
 * The shipped figma-pull skill: resolves from the package, parses as a valid
 * Agent Skill, and loads through the SAME DefaultResourceLoader seam the Pi
 * session uses — with projectTrusted FALSE — proving trust-independence
 * without enabling untrusted repo .pi/ skills.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadSkillsFromDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createDesignbookResourceLoader, packagedSkillsDir } from "./piSkills.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("packagedSkillsDir", () => {
  it("resolves the shipped skills dir from the package root", () => {
    const dir = packagedSkillsDir(packageRoot);
    expect(dir).toBe(resolve(packageRoot, "skills"));
  });

  it("returns undefined when no skills dir exists", () => {
    expect(packagedSkillsDir(tempDir("db-no-skills-"))).toBeUndefined();
  });
});

describe("figma-pull SKILL.md", () => {
  it("parses as a valid Agent Skill with the auto-invocation description", () => {
    const { skills, diagnostics } = loadSkillsFromDir({
      dir: packagedSkillsDir(packageRoot)!,
      source: "designbook",
    });
    expect(diagnostics).toEqual([]);
    const skill = skills.find((candidate) => candidate.name === "figma-pull");
    expect(skill).toBeDefined();
    expect(skill!.description).toContain("Figma pull target");
    expect(skill!.disableModelInvocation).toBe(false);
  });
});

describe("createDesignbookResourceLoader", () => {
  it("loads the shipped skill with projectTrusted=false, without repo .pi skills", async () => {
    // A repo with an untrusted .pi/skills skill that must NOT load.
    const cwd = tempDir("db-untrusted-repo-");
    const repoSkillDir = join(cwd, ".pi", "skills", "repo-skill");
    mkdirSync(repoSkillDir, { recursive: true });
    writeFileSync(
      join(repoSkillDir, "SKILL.md"),
      "---\nname: repo-skill\ndescription: untrusted repo skill\n---\nbody\n",
    );
    // Hermetic agent dir (no ~/.pi global skills bleeding in).
    const agentDir = tempDir("db-agent-");

    const loader = await createDesignbookResourceLoader({
      packageRoot,
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir, {
        projectTrusted: false,
      }),
    });
    expect(loader).toBeDefined();

    const names = loader!.getSkills().skills.map((skill) => skill.name);
    expect(names).toContain("figma-pull"); // package asset: trust-independent
    expect(names).not.toContain("repo-skill"); // untrusted repo skill stays gated
  });

  it("returns undefined (SDK default loader) when the skills dir is missing", async () => {
    const cwd = tempDir("db-empty-");
    const agentDir = tempDir("db-agent2-");
    const loader = await createDesignbookResourceLoader({
      packageRoot: cwd,
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir, {
        projectTrusted: false,
      }),
    });
    expect(loader).toBeUndefined();
  });
});
