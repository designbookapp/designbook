import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isNonLoopbackBindHost } from "../node/plugin/apiOrigin.ts";
import {
  findDefaultConfig,
  PRIMARY_CONFIG_NAME,
} from "../node/config/configDiscovery.ts";
import { startDesignbook } from "../node/sidecar/server.ts";
import { runDev } from "./dev.ts";
import { runInit } from "./init.ts";

const HELP = `designbook — design workbench for React repos

Usage:
  designbook init [options]          Scaffold injected-mode files into a Vite
                                     app (see \`designbook init -h\`)
  designbook dev [config] [options]  Sidecar + proxy front (injects into your
                                     app's dev server; see \`designbook dev -h\`)
  designbook [config] [options]      Host mode (embedded workbench dev server)

Arguments:
  config              Path to the designbook config file. Defaults to
                      designbook.config.{tsx,ts,jsx,js} in the current directory.

Options:
  -p, --port <port>   Port to listen on (default: 8787, env DESIGNBOOK_PORT)
      --host <host>   Host to bind (default: localhost)
      --allow-lan     Required to bind a non-loopback --host (e.g. 0.0.0.0 or
                      a LAN IP). Without it, a non-loopback --host refuses to
                      start — this exposes an unauthenticated code-editing
                      agent to the network.
      --read-only     Restrict the Pi agent to read-only tools (no bash/edit/
                      write) and reject the file-write data endpoints (403).
      --trust-project Trust this repo's .pi/ dir (extensions/*.ts,
                      settings.json, SYSTEM.md) — same as Pi's own trust
                      gate. Default: untrusted, so .pi/ content in a repo you
                      just opened doesn't auto-run.
      --root <dir>    Project root the agent works in (default: the git root
                      above the config file, env DESIGNBOOK_CWD)
      --no-open       Don't open (or refocus) the workbench in a browser
      --debug         Verbose logging: API requests + Pi agent events
                      (errors are always logged; env DESIGNBOOK_DEBUG=1)
  -h, --help          Show this help
`;

// Subcommand dispatch: `designbook dev …` is the injected-mode sidecar/proxy. Bare
// `designbook …` stays host mode (everything below).
if (process.argv[2] === "dev") {
  runDev(process.argv.slice(3)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
} else if (process.argv[2] === "init") {
  runInit(process.argv.slice(3)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
} else {
  runHost();
}

function runHost() {

function findGitRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function fail(message: string): never {
  console.error(`designbook: ${message}`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: "string", short: "p" },
    host: { type: "string" },
    "allow-lan": { type: "boolean" },
    "read-only": { type: "boolean" },
    "trust-project": { type: "boolean" },
    root: { type: "string" },
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

const port = Number(
  values.port ?? process.env.DESIGNBOOK_PORT ?? process.env.PORT ?? 8787,
);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  fail(`invalid port: ${values.port ?? process.env.DESIGNBOOK_PORT}`);
}

// Auto-open only for interactive runs: spawned instances (worktrees, CI)
// should never pop browser windows.
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
    `designbook: WARNING — bound to ${host}, reachable by anyone on the network with no authentication.`,
  );
}

  startDesignbook({
    configPath,
    projectRoot,
    port,
    host,
    open,
    debug: values.debug ?? process.env.DESIGNBOOK_DEBUG === "1",
    readOnly: values["read-only"] ?? false,
    trustProject: values["trust-project"] ?? false,
  }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
