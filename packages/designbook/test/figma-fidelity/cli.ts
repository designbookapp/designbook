/**
 * Argument parsing for `pnpm test:figma` (docs/specs/figma-sync-testing.md).
 * Pure: `parseCliArgs(argv)` maps the raw args to a config the runner
 * consumes, so it is unit tested without spawning anything.
 *
 * Usage:
 *   pnpm test:figma [options]
 *     --port <n>          Sidecar port (default 8791; must stay in 8787–8797).
 *     --case <id>         Run only this case (repeatable, or comma-separated).
 *     --vision [all]      Tier-3 agent compare: flagged cases, or `all`.
 *     --approve <id|all>  Promote pulled.html → expected.html after review.
 *     --keep-results      Keep the results/<timestamp> dir even on full pass.
 *     -h, --help          Show help.
 */

/** Default sidecar port — decision 2 (inside the plugin's 8787–8797 probe). */
const DEFAULT_PORT = 8791;

type CliOptions = {
  port: number;
  /** Case-id filter; undefined = all cases. */
  cases?: string[];
  /** Run the tier-3 vision compare. */
  vision: boolean;
  /** Vision on every case, not just tier-2-flagged ones. */
  visionAll: boolean;
  /** Case ids to approve (promote snapshot); empty unless --approve given. */
  approve: string[];
  /** `--approve all` — approve every run case. */
  approveAll: boolean;
  /** Keep the results dir even when everything passes. */
  keepResults: boolean;
  help: boolean;
};

/** Splits `a,b , c` into `["a","b","c"]`, dropping blanks. */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: DEFAULT_PORT,
    cases: undefined,
    vision: false,
    visionAll: false,
    approve: [],
    approveAll: false,
    keepResults: false,
    help: false,
  };
  const cases: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    /** Reads an inline `=value` or the next token as this flag's value. */
    const takeValue = (): string | undefined => {
      const eq = arg.indexOf("=");
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        i++;
        return next;
      }
      return undefined;
    };
    const name = arg.startsWith("--") ? arg.slice(2).split("=")[0] : arg;

    switch (name) {
      case "port": {
        const value = takeValue();
        const port = Number(value);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new Error(`--port: invalid port "${value ?? ""}"`);
        }
        options.port = port;
        break;
      }
      case "case": {
        const value = takeValue();
        if (value) cases.push(...splitList(value));
        break;
      }
      case "vision": {
        options.vision = true;
        const value = takeValue();
        if (value === "all") options.visionAll = true;
        else if (value) cases.push(...splitList(value)); // `--vision a,b`: scope
        break;
      }
      case "approve": {
        const value = takeValue();
        if (value === "all" || value === undefined) options.approveAll = true;
        else options.approve.push(...splitList(value));
        break;
      }
      case "keep-results":
        options.keepResults = true;
        break;
      case "-h":
      case "h":
      case "help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (cases.length > 0) options.cases = cases;
  return options;
}

export { parseCliArgs, DEFAULT_PORT };
export type { CliOptions };
