/**
 * Loads designbook's SHIPPED Agent Skills (skills/figma-pull/…) into the
 * embedded Pi session. The skills are designbook's own package assets — NOT
 * repo content — so they must load regardless of `projectTrusted`. The seam:
 * `DefaultResourceLoader`'s `additionalSkillPaths` are merged into the skill
 * set unconditionally (trust only gates SETTINGS-enabled project resources,
 * see pi-coding-agent dist/core/resource-loader.js `reload()`), so passing a
 * loader built with the SAME cwd/agentDir/settingsManager that
 * `createAgentSession` would build internally changes nothing else — repo
 * `.pi/` resources stay gated exactly as before.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Absolute path to the packaged skills directory, or undefined when missing
 * (never expected in a healthy install — `skills/` ships in the npm `files`
 * list and the build also copies it to `dist/skills`).
 */
function packagedSkillsDir(packageRoot: string): string | undefined {
  for (const candidate of [
    resolve(packageRoot, "skills"),
    resolve(packageRoot, "dist", "skills"),
  ]) {
    if (existsSync(resolve(candidate, "figma-pull", "SKILL.md"))) {
      return candidate;
    }
  }
  return undefined;
}

type DesignbookResourceLoaderOptions = {
  /** designbook package root (the dir containing package.json + skills/). */
  packageRoot: string;
  /** The Pi session cwd (agentCwd). */
  cwd: string;
  /** Settings manager already carrying the projectTrusted decision. */
  settingsManager: SettingsManager;
  /** Override for tests (defaults to Pi's ~/.pi/agent). */
  agentDir?: string;
};

/**
 * Builds the resource loader for `createAgentSession`: the same
 * DefaultResourceLoader the SDK would create on its own, plus designbook's
 * packaged skills dir as an `additionalSkillPaths` entry (trust-independent,
 * see module doc). Returns undefined when the skills dir is missing so the
 * caller can fall back to the SDK default loader.
 */
async function createDesignbookResourceLoader(
  options: DesignbookResourceLoaderOptions,
): Promise<ResourceLoader | undefined> {
  const skillsDir = packagedSkillsDir(options.packageRoot);
  if (!skillsDir) return undefined;
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    settingsManager: options.settingsManager,
    additionalSkillPaths: [skillsDir],
  });
  await loader.reload();
  return loader;
}

export { createDesignbookResourceLoader, packagedSkillsDir };
