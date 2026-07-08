/**
 * Shared config-discovery order for the CLI (host + `dev`) and the injected
 * plugin. `.designbook/config.*` is preferred — `.designbook/` is THE designbook
 * folder per host app. The legacy repo-root `designbook.config.*` still works.
 *
 * All consumers use the same cwd semantics: candidates are resolved against the
 * caller's cwd (the app root), so a root-level legacy file keeps resolving.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Discovery order: `.designbook/config.*` first, then legacy root files. */
const DEFAULT_CONFIG_NAMES = [
  ".designbook/config.tsx",
  ".designbook/config.ts",
  ".designbook/config.jsx",
  ".designbook/config.js",
  "designbook.config.tsx",
  "designbook.config.ts",
  "designbook.config.jsx",
  "designbook.config.js",
] as const;

/** The name shown in "not found" / init messaging (the recommended location). */
const PRIMARY_CONFIG_NAME = DEFAULT_CONFIG_NAMES[0];

/** First existing config in `cwd`, in discovery order, or undefined. */
function findDefaultConfig(cwd: string): string | undefined {
  for (const name of DEFAULT_CONFIG_NAMES) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export { DEFAULT_CONFIG_NAMES, PRIMARY_CONFIG_NAME, findDefaultConfig };
