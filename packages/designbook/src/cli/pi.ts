/**
 * `designbook pi [args…]` and `designbook login`.
 *
 * Runs the Pi coding agent CLI that ships *inside* designbook's own dependency
 * tree. We resolve its bin from `@earendil-works/pi-coding-agent`'s package.json
 * (createRequire on our own module) rather than trusting `node_modules/.bin` —
 * pnpm and yarn-pnp don't link a transitive dep's bins into the consumer app,
 * and the npm registry has an unrelated ancient `pi` package, so `npx pi` in a
 * pnpm/yarn-pnp app runs the wrong thing (or nothing). Going through our own
 * dependency graph always reaches the right binary.
 *
 * `login` is sugar for `pi` with no passthrough args: Pi has no `--login` flag —
 * login is the interactive `/login` slash command — so we spawn it interactively
 * and print a one-line hint.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Given a parsed package.json and the absolute path it was read from, resolve
 * the absolute path to its `pi` CLI entry. Pure so it can be unit-tested against
 * the bin-field shapes npm allows (string, or object keyed by bin name).
 */
function resolvePiBinFromPackageJson(
  pkg: { bin?: string | Record<string, string> },
  pkgJsonPath: string,
): string {
  const { bin } = pkg;
  let rel: string | undefined;
  if (typeof bin === "string") {
    rel = bin;
  } else if (bin && typeof bin === "object") {
    rel = bin.pi ?? Object.values(bin)[0];
  }
  if (!rel) {
    throw new Error(`${PI_PACKAGE} exposes no bin entry`);
  }
  const pkgDir = dirname(pkgJsonPath);
  return isAbsolute(rel) ? rel : resolve(pkgDir, rel);
}

/**
 * Walk up from a file inside a package to its package.json — the one whose
 * `name` matches. We can't `require.resolve("<pkg>/package.json")` directly:
 * a package with an `exports` map (Pi has one) forbids un-exported subpaths, so
 * that throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolving the main entry (an
 * exported path) and walking up is the portable way to the package root.
 */
function findPackageJsonFrom(
  startFile: string,
  packageName: string,
): string | undefined {
  let dir = dirname(startFile);
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
        };
        if (parsed.name === packageName) return candidate;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve the Pi CLI entry from designbook's own dependency tree. Throws a
 * friendly error if the package (a designbook dependency) can't be found.
 *
 * Uses `import.meta.resolve` (ESM conditions), NOT `createRequire().resolve`:
 * Pi's `exports` map only defines an `import` condition, so CJS resolution
 * fails with ERR_PACKAGE_PATH_NOT_EXPORTED. Resolution is relative to THIS
 * module, which lives inside the designbook package — so it always reaches the
 * Pi copy in designbook's own dependency tree, regardless of the host app's
 * package manager (pnpm/yarn-pnp never link a transitive dep's bins).
 */
function resolvePiCli(): string {
  let entry: string;
  try {
    // The "." export (an allowed subpath) — a file inside the package.
    entry = fileURLToPath(import.meta.resolve(PI_PACKAGE));
  } catch {
    throw new Error(
      `could not resolve ${PI_PACKAGE} — it ships as a designbook dependency; ` +
        `try reinstalling designbook.`,
    );
  }
  const pkgJsonPath = findPackageJsonFrom(entry, PI_PACKAGE);
  if (!pkgJsonPath) {
    throw new Error(
      `could not locate ${PI_PACKAGE}'s package.json from ${entry}`,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  return resolvePiBinFromPackageJson(pkg, pkgJsonPath);
}

/** Spawn the Pi CLI with inherited stdio; resolve with its exit code. */
function spawnPi(binPath: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: "inherit",
    });
    child.on("error", (error: Error) => {
      console.error(`designbook: failed to launch Pi CLI: ${error.message}`);
      resolvePromise(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        // Mirror the conventional 128+signal exit for a killed child.
        resolvePromise(128 + 1);
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

/**
 * `designbook pi [args…]` — passthrough to the bundled Pi CLI.
 * `login === true` prepends the login hint (interactive `/login` flow).
 */
async function runPi(argv: string[], login = false): Promise<void> {
  let binPath: string;
  try {
    binPath = resolvePiCli();
  } catch (error) {
    console.error(
      `designbook: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (login) {
    // Pi has no --login flag; login is the interactive /login slash command.
    console.log("designbook: launching Pi — run /login, then /exit.");
  }

  const code = await spawnPi(binPath, argv);
  process.exit(code);
}

/** `designbook login` — sugar for an interactive `pi` with a login hint. */
function runLogin(argv: string[]): Promise<void> {
  return runPi(argv, true);
}

export {
  runPi,
  runLogin,
  // Pure helper (exported for unit tests):
  resolvePiBinFromPackageJson,
};
