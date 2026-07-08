/**
 * Copies the shipped Agent Skills (skills/) into dist/skills so a build
 * output is self-contained. The npm package ALSO ships skills/ directly (see
 * package.json "files"); runtime resolution tries skills/ first, then
 * dist/skills (src/node/api/piSkills.ts `packagedSkillsDir`).
 */
import { cpSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "dist", "skills");
rmSync(target, { recursive: true, force: true });
cpSync(resolve(root, "skills"), target, { recursive: true });
console.log(`copied skills/ -> dist/skills`);
