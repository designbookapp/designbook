/**
 * `designbook dev` — sidecar + proxy front.
 *
 * Runs the API/agent/figma/worktree sidecar on a stable port and proxies the
 * target app's OWN dev server (which loads `designbookPlugin`) behind it, so the
 * user sees one URL. Bare `designbook` stays host mode (server.ts).
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isNonLoopbackBindHost } from "../node/plugin/apiOrigin.ts";
import {
  findDefaultConfig,
  PRIMARY_CONFIG_NAME,
} from "../node/config/configDiscovery.ts";
import { startSidecar } from "../node/sidecar/sidecar.ts";

const HELP = `designbook dev — sidecar + proxy front

Runs the designbook API sidecar on a stable port and proxies your app's own
dev server behind it (which must load designbookPlugin()). One URL for the
user; recovery page when the app is down; worktree switches keep the URL.

Convention: add "design": "designbook dev" to package.json scripts.

Usage:
  designbook dev [config] [options]

Options:
  -p, --port <port>        Stable port the user connects to (default: 8787,
                           env DESIGNBOOK_PORT)
      --host <host>        Host to bind (default: localhost)
      --allow-lan          Required to bind a non-loopback --host (e.g.
                           0.0.0.0 or a LAN IP). Without it, a non-loopback
                           --host refuses to start — this exposes an
                           unauthenticated code-editing agent to the network.
      --read-only          Restrict the Pi agent to read-only tools (no bash/
                           edit/write) and reject the file-write data
                           endpoints (403).
      --trust-project      Trust this repo's .pi/ dir (extensions/*.ts,
                           settings.json, SYSTEM.md) — same as Pi's own trust
                           gate. Default: untrusted.
      --root <dir>         Project root the agent works in (default: git root
                           above the config, env DESIGNBOOK_CWD)
      --target-url <url>   Attach to an already-running target dev server
                           instead of spawning one.
      --target-cmd <cmd>   Command to spawn the target dev server
                           (default: the project's package.json "dev" script).
      --target-cwd <dir>   Directory to spawn the target dev command in
                           (default: the nearest package.json at/above the
                           config — where the app's scripts live, which in a
                           monorepo is the app package, NOT the git root).
      --target-port <n>    Force/known target port (skips log discovery).
      --api-port <port>    Direct api port where plain /api/* is designbook's,
                           unproxied (default: --port + 1). Warns + skips if
                           taken; the proxy's /__designbook/api still works.
      --no-open            Don't open the browser.
      --debug              Verbose logging (env DESIGNBOOK_DEBUG=1)
  -h, --help               Show this help
`;

function findGitRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Nearest ancestor (inclusive) of `startDir` that has a package.json — the
 * directory whose `dev`/`design` scripts we spawn. For a root-level config this
 * is the app root; for `.designbook/config.tsx` it is the parent app package
 * (the `.designbook/` folder has no package.json), which is exactly where the
 * scripts live in a monorepo app.
 */
function findNearestPackageJson(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function fail(message: string): never {
  console.error(`designbook dev: ${message}`);
  process.exit(1);
}

async function runDev(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      "allow-lan": { type: "boolean" },
      "read-only": { type: "boolean" },
      "trust-project": { type: "boolean" },
      root: { type: "string" },
      "target-url": { type: "string" },
      "target-cmd": { type: "string" },
      "target-cwd": { type: "string" },
      "target-port": { type: "string" },
      "api-port": { type: "string" },
      open: { type: "boolean" },
      "no-open": { type: "boolean" },
      debug: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const cwd = process.cwd();
  const configArg = positionals[0];
  const configPath = configArg
    ? resolve(cwd, configArg)
    : findDefaultConfig(cwd);

  if (!configPath) {
    fail(
      `no config file found. Pass one explicitly or create ${PRIMARY_CONFIG_NAME} in ${cwd}.`,
    );
  }
  if (!existsSync(configPath)) {
    fail(`config file does not exist: ${configPath}`);
  }

  const rootArg = values.root ?? process.env.DESIGNBOOK_CWD;
  const projectRoot = rootArg
    ? isAbsolute(rootArg)
      ? rootArg
      : resolve(cwd, rootArg)
    : (findGitRoot(dirname(configPath)) ?? dirname(configPath));

  if (!existsSync(projectRoot)) {
    fail(`project root does not exist: ${projectRoot}`);
  }

  // Where to spawn the target dev command. Defaults to the app package (nearest
  // package.json at/above the config), NOT the git root — in a monorepo the
  // `dev`/`design` scripts live in the app package. `--root` (agent cwd) is a
  // separate concern and still defaults to the git root above.
  const targetCwdArg = values["target-cwd"];
  const targetCwd = targetCwdArg
    ? isAbsolute(targetCwdArg)
      ? targetCwdArg
      : resolve(cwd, targetCwdArg)
    : (findNearestPackageJson(dirname(configPath)) ?? dirname(configPath));

  if (!existsSync(targetCwd)) {
    fail(`--target-cwd does not exist: ${targetCwd}`);
  }

  const port = Number(
    values.port ?? process.env.DESIGNBOOK_PORT ?? process.env.PORT ?? 8787,
  );
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`invalid port: ${values.port ?? process.env.DESIGNBOOK_PORT}`);
  }

  let targetPort: number | undefined;
  if (values["target-port"] !== undefined) {
    targetPort = Number(values["target-port"]);
    if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
      fail(`invalid --target-port: ${values["target-port"]}`);
    }
  }

  let apiPort: number | undefined;
  if (values["api-port"] !== undefined) {
    apiPort = Number(values["api-port"]);
    if (!Number.isInteger(apiPort) || apiPort <= 0 || apiPort > 65535) {
      fail(`invalid --api-port: ${values["api-port"]}`);
    }
  }

  const open =
    values.open ??
    (!values["no-open"] && Boolean(process.stdout.isTTY) && !process.env.CI);

  const host = values.host ?? "localhost";

  if (isNonLoopbackBindHost(host) && !values["allow-lan"]) {
    fail(
      `--host ${host} binds to more than localhost, exposing an UNAUTHENTICATED code-editing agent to your whole network. Pass --allow-lan if you understand this, or prefer localhost.`,
    );
  }
  if (isNonLoopbackBindHost(host)) {
    console.warn(
      `designbook dev: WARNING — bound to ${host}, reachable by anyone on the network with no authentication.`,
    );
  }

  await startSidecar({
    configPath,
    projectRoot,
    port,
    host,
    open,
    debug: values.debug ?? process.env.DESIGNBOOK_DEBUG === "1",
    targetUrl: values["target-url"],
    targetCmd: values["target-cmd"],
    targetCwd,
    targetPort,
    apiPort,
    readOnly: values["read-only"] ?? false,
    trustProject: values["trust-project"] ?? false,
  });
}

export { runDev };
