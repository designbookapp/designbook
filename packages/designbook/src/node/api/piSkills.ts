/**
 * Loads the integrations' SHIPPED Agent Skills (e.g. the figma plugin's
 * figma-pull skill, contributed via `PluginNodeSpec.skillsDir`) into the
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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * designbook's own (non-integration) packaged skills — currently the
 * `variations` skill. Resolved relative to the COMPILED module, mirroring the
 * figma plugin's `figmaSkillsDir`: `src/node/api` → `src/skills` from source,
 * `dist/node/api` → `dist/skills` in a build (see scripts/copy-skills.mjs).
 */
function designbookCoreSkillsDir(): string | undefined {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
  return existsSync(dir) ? dir : undefined;
}

type DesignbookResourceLoaderOptions = {
  /**
   * Absolute packaged-skill dirs to load (integration `skillsDir`
   * contributions — e.g. the figma plugin's figma-pull skill). Non-existent
   * entries are skipped.
   */
  skillPaths: string[];
  /** The Pi session cwd (agentCwd). */
  cwd: string;
  /** Settings manager already carrying the projectTrusted decision. */
  settingsManager: SettingsManager;
  /** Override for tests (defaults to Pi's ~/.pi/agent). */
  agentDir?: string;
};

/**
 * Builds the resource loader for `createAgentSession`: the same
 * DefaultResourceLoader the SDK would create on its own, plus the
 * integrations' packaged skills dirs as `additionalSkillPaths` entries
 * (trust-independent, see module doc). Returns undefined when no skills dir
 * exists so the caller can fall back to the SDK default loader.
 */
async function createDesignbookResourceLoader(
  options: DesignbookResourceLoaderOptions,
): Promise<ResourceLoader | undefined> {
  const skillPaths = options.skillPaths.filter((dir) => existsSync(dir));
  if (skillPaths.length === 0) return undefined;
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    settingsManager: options.settingsManager,
    additionalSkillPaths: skillPaths,
  });
  await loader.reload();
  return loader;
}

export { createDesignbookResourceLoader, designbookCoreSkillsDir };
