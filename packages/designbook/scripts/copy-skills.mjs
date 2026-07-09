/**
 * Copies each integration plugin's packaged Agent Skills into dist so a build
 * output is self-contained (the node halves resolve `../skills` next to their
 * COMPILED module — see src/plugins/figma/node `figmaSkillsDir`). The npm
 * package ALSO ships the source tree (`src/plugins` in package.json "files"),
 * which is the resolution hit when running from source.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const skillDirs = [
  ["src/plugins/figma/skills", "dist/plugins/figma/skills"],
  // Core (non-integration) skills — currently `variations`; resolved by
  // designbookCoreSkillsDir in src/node/api/piSkills.ts.
  ["src/skills", "dist/skills"],
];

for (const [from, to] of skillDirs) {
  const source = resolve(root, from);
  const target = resolve(root, to);
  if (!existsSync(source)) {
    console.error(`copy-skills: missing ${from}`);
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
