/**
 * `pnpm test:figma` — the fidelity harness runner (docs/specs/figma-sync-testing.md).
 *
 * NOT vitest: sequential, stateful (one shared Figma page), long-running, and
 * its output is a report a human reviews. It spawns the designbook sidecar
 * against `fidelity.config.tsx`, drives a headless browser through each case,
 * pushes via the REAL button, exports the Figma render, pulls the annotated
 * HTML, and compares (tier 1 gates the exit code; tier 2 pixel is P2).
 *
 * This is the manual-run orchestrator: it requires Figma desktop open with the
 * designbook plugin attached (see README.md "Run ritual"). The pure logic it
 * calls (cli/normalize/report/caseConfig) is unit tested; this glue is verified
 * on the first real run. Boundaries flagged "VERIFY ON FIRST RUN" are the
 * UI-navigation assumptions no unit test can cover.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs, type CliOptions } from "./cli.ts";
import {
  CASES,
  caseEntryId,
  caseRoute,
  caseEntrySelector,
  type FidelityCase,
} from "./caseConfig.ts";
import { compareHtml } from "./normalize.ts";
import {
  renderReport,
  summarize,
  type CaseOutcome,
  type RunReport,
} from "./report.ts";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(harnessDir, "../..");
const configPath = resolve(harnessDir, "fidelity.config.tsx");
const cliEntry = resolve(packageRoot, "dist/cli/index.js");
const resultsRoot = resolve(harnessDir, "results");

/** Chrome channel / executable for playwright-core (no bundled browser). */
const CHROME_CHANNEL = process.env.DESIGNBOOK_FIDELITY_CHROME_CHANNEL ?? "chrome";
const CHROME_PATH = process.env.DESIGNBOOK_FIDELITY_CHROME_PATH;

const SCALE = 2;

function log(message: string): void {
  console.log(`[fidelity] ${message}`);
}

/**
 * Hard exit for setup errors. ONLY safe before the sidecar child is spawned:
 * process.exit skips try/finally, so calling this later would orphan the
 * sidecar (throw instead — main() reaps and exits nonzero).
 */
function fail(message: string): never {
  console.error(`[fidelity] ${message}`);
  process.exit(2);
}

function gitCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: packageRoot,
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

// --- Sidecar --------------------------------------------------------------

/** Polls `GET /api/figma-hello` until the sidecar answers or the deadline. */
async function waitForSidecar(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://localhost:${port}/api/figma-hello`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`sidecar did not start on port ${port} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function spawnSidecar(port: number): ChildProcess {
  if (!existsSync(cliEntry)) {
    fail(
      `built CLI not found at ${cliEntry}. Run \`pnpm --filter '@designbookapp/designbook' build\` first.`,
    );
  }
  log(`starting sidecar on port ${port}…`);
  const child = spawn(
    process.execPath,
    [cliEntry, configPath, "--port", String(port), "--no-open"],
    { cwd: packageRoot, stdio: ["ignore", "inherit", "inherit"] },
  );
  return child;
}

type FigmaStatus = {
  connected: boolean;
  info: { fileName?: string; page?: string } | null;
};

async function figmaStatus(port: number): Promise<FigmaStatus> {
  const response = await fetch(`http://localhost:${port}/api/figma/status`);
  return (await response.json()) as FigmaStatus;
}

/**
 * Preflight (spec): a connected plugin + open file. The plugin probes
 * 8787→8797 every few seconds, so an already-running plugin needs a moment to
 * find a sidecar that just started — poll for the connection instead of
 * failing on the first look. THROWS on timeout (never `fail()`/process.exit:
 * that would skip the caller's `finally` and orphan the sidecar child).
 */
async function preflight(
  port: number,
  timeoutMs = 90_000,
): Promise<FigmaStatus> {
  const deadline = Date.now() + timeoutMs;
  let waiting = false;
  for (;;) {
    const status = await figmaStatus(port).catch(() => undefined);
    if (status?.connected) {
      log(
        `plugin connected — file "${status.info?.fileName ?? "?"}", page "${status.info?.page ?? "?"}"`,
      );
      return status;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `No Figma plugin connected after ${Math.round(timeoutMs / 1000)}s. ` +
          "Open Figma desktop, run the designbook plugin, and make sure NO " +
          "other designbook instance is running on a lower port (the plugin " +
          `probes 8787→8797 and attaches to the first it finds; this harness ` +
          `uses ${port}). Then re-run.`,
      );
    }
    if (!waiting) {
      waiting = true;
      log(
        `waiting up to ${Math.round(timeoutMs / 1000)}s for the Figma plugin — ` +
          "run the designbook plugin in Figma desktop now (an already-open " +
          "plugin re-probes and will attach by itself)…",
      );
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

// --- Per-case pipeline ----------------------------------------------------

type Page = import("playwright-core").Page;

/** Stages 1–2: render the case in the browser and screenshot its root. */
async function captureBrowser(
  page: Page,
  entry: FidelityCase,
  port: number,
  caseDir: string,
): Promise<void> {
  const url = `http://localhost:${port}/${caseRoute(entry.id)}`;
  // "domcontentloaded", NOT "networkidle": the workbench polls the sidecar
  // (Figma status every 5s, changes/host-context timers), so the network never
  // idles and a networkidle goto times out (verified on the first real run).
  // The entry-root visibility wait below is the actual readiness signal.
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const selector = `[data-db-entry="${caseEntrySelector(entry.id)}"]`;
  const root = page.locator(selector).first();
  await root.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(300); // settle fonts/layout
  await root.screenshot({ path: resolve(caseDir, "browser.png") });
}

/**
 * Opens the left-rail Figma tab (SideRail button, aria-label "Figma") so the
 * FigmaPanel hosting the push button is mounted. Idempotent: re-clicking the
 * active tab is a no-op, so this runs unconditionally per case.
 */
async function openFigmaTab(page: Page): Promise<void> {
  const tab = page
    .locator('nav[aria-label="Workbench panels"] button[aria-label="Figma"]')
    .first();
  await tab.waitFor({ state: "visible", timeout: 15_000 });
  await tab.click();
}

/**
 * Stage 3: click the REAL push button (decision 6, lives in the FigmaPanel —
 * openFigmaTab first) and wait for the done status ("Created/Updated in
 * Figma…", role=status) or fail fast on the panel's role=alert error. Returns
 * any push warnings surfaced in the UI.
 */
async function pushViaButton(page: Page): Promise<string[]> {
  const button = page.locator('[data-testid="figma-push"]').first();
  await button.waitFor({ state: "visible", timeout: 15_000 });
  // click() auto-waits for enabled — covers the connection-poll gate.
  await button.click();
  const status = page.locator('[role="status"]').filter({ hasText: /in Figma/ });
  const alert = page.locator('[role="alert"]');
  const winner = await Promise.race([
    status.waitFor({ state: "visible", timeout: 120_000 }).then(() => "status"),
    alert
      .first()
      .waitFor({ state: "visible", timeout: 120_000 })
      .then(() => "alert")
      .catch(() => "none"), // no alert within the window — status path decides
  ]);
  if (winner === "alert") {
    throw new Error(
      `push failed in UI: ${((await alert.first().textContent()) ?? "").trim()}`,
    );
  }
  const text = (await status.textContent()) ?? "";
  const match = /(\d+) warning\(s\)/.exec(text);
  if (match && Number(match[1]) > 0) {
    // The actual warning lines live in the status span's title attribute
    // (FigmaSyncControls joins them with \n) — surface them in the report.
    const detail = ((await status.getAttribute("title")) ?? "").trim();
    return detail.length > 0
      ? detail.split("\n").map((line) => line.trim())
      : [`push reported ${match[1]} warning(s): ${text.trim()}`];
  }
  return [];
}

/**
 * One-time run setup: sync the theme-token variable collection to Figma via
 * the FigmaPanel Variables section ("Sync to Figma"), so pushes can bind
 * `data-token-*` attributions to real Figma variables (fidelity.config.tsx
 * registers `designbook/theme`; without this first sync the bound variables
 * don't exist and token attribution is silently dropped on pull).
 */
async function syncVariables(page: Page, port: number): Promise<void> {
  await page.goto(`http://localhost:${port}/`, {
    waitUntil: "domcontentloaded",
  });
  await openFigmaTab(page);
  const button = page.getByRole("button", { name: "Sync to Figma", exact: true });
  await button.waitFor({ state: "visible", timeout: 15_000 });
  await button.click();
  const status = page.locator('[role="status"]').filter({ hasText: /^Pushed/ });
  const alert = page.locator('[role="alert"]');
  const winner = await Promise.race([
    status.waitFor({ state: "visible", timeout: 60_000 }).then(() => "status"),
    alert
      .first()
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => "alert")
      .catch(() => "none"),
  ]);
  if (winner === "alert") {
    throw new Error(
      `variable sync failed: ${((await alert.first().textContent()) ?? "").trim()}`,
    );
  }
  log(`variables synced — ${((await status.textContent()) ?? "").trim()}`);
}

type ExportResult = { base64: string; width: number; height: number };

/** Stage 4: export the Figma render as PNG. */
async function exportFigma(
  port: number,
  entryId: string,
  caseDir: string,
): Promise<void> {
  const response = await fetch(`http://localhost:${port}/api/figma/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ componentId: entryId, scale: SCALE }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(`export failed (${response.status}): ${body.error ?? ""}`);
  }
  const result = (await response.json()) as ExportResult;
  await writeFile(
    resolve(caseDir, "figma.png"),
    Buffer.from(result.base64, "base64"),
  );
}

/** Stage 5: pull the annotated HTML back. */
async function pullHtml(port: number, entryId: string): Promise<string> {
  const response = await fetch(
    `http://localhost:${port}/api/figma/html?componentId=${encodeURIComponent(entryId)}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(`pull failed (${response.status}): ${body.error ?? ""}`);
  }
  const payload = (await response.json()) as { html: string };
  return payload.html;
}

function caseSourceDir(entry: FidelityCase): string {
  return resolve(harnessDir, "cases", entry.id);
}

/** Runs the full pipeline for one case, producing its report outcome. */
async function runCase(
  page: Page,
  entry: FidelityCase,
  port: number,
  runDir: string,
): Promise<CaseOutcome> {
  const entryId = caseEntryId(entry.id);
  const caseDir = resolve(runDir, entry.id);
  await mkdir(caseDir, { recursive: true });
  const outcome: CaseOutcome = {
    id: entry.id,
    note: entry.note,
    status: "pass",
    warnings: [],
    browserPng: `${entry.id}/browser.png`,
    figmaPng: `${entry.id}/figma.png`,
  };

  try {
    await captureBrowser(page, entry, port, caseDir);
    await openFigmaTab(page);
    outcome.warnings = await pushViaButton(page);
    await exportFigma(port, entryId, caseDir);
    const pulled = await pullHtml(port, entryId);
    await writeFile(resolve(caseDir, "pulled.html"), pulled, "utf8");

    if (!entry.tiers.html) {
      outcome.status = "skip";
      return outcome;
    }

    const expectedPath = resolve(caseSourceDir(entry), "expected.html");
    if (!existsSync(expectedPath)) {
      // Approve-on-first-run (decision 5): no baseline yet — record, don't fail.
      outcome.status = "new";
      outcome.tier1 = { equal: false, mismatches: [], baseline: "missing" };
      return outcome;
    }
    const expected = await readFile(expectedPath, "utf8");
    const result = compareHtml(expected, pulled, {
      pxTolerance: entry.pixelThreshold,
    });
    outcome.tier1 = {
      equal: result.equal,
      mismatches: result.mismatches,
      baseline: "approved",
    };
    outcome.status = result.equal ? "pass" : "fail";
  } catch (error) {
    outcome.status = "error";
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

// --- Approve flow ---------------------------------------------------------

/**
 * Promotes a case's freshly pulled HTML to its committed `expected.html`. Reads
 * from the most recent run dir's pulled.html.
 */
async function approveCase(entry: FidelityCase, runDir: string): Promise<boolean> {
  const pulled = resolve(runDir, entry.id, "pulled.html");
  if (!existsSync(pulled)) return false;
  const dest = resolve(caseSourceDir(entry), "expected.html");
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(pulled, dest);
  log(`approved ${entry.id} → ${dest}`);
  return true;
}

// --- Main -----------------------------------------------------------------

function selectCases(options: CliOptions): FidelityCase[] {
  if (!options.cases) return CASES;
  const wanted = new Set(options.cases);
  const chosen = CASES.filter((entry) => wanted.has(entry.id));
  const unknown = options.cases.filter(
    (id) => !CASES.some((entry) => entry.id === id),
  );
  if (unknown.length > 0) fail(`unknown case(s): ${unknown.join(", ")}`);
  return chosen;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (options.help) {
    console.log(
      "pnpm test:figma [--port n] [--case id] [--vision [all]] [--approve id|all] [--keep-results]",
    );
    return;
  }

  const cases = selectCases(options);
  const startedAt = new Date().toISOString();
  const runDir = resolve(resultsRoot, startedAt.replace(/[:.]/g, "-"));
  await mkdir(runDir, { recursive: true });

  const sidecar = spawnSidecar(options.port);
  let browser: import("playwright-core").Browser | undefined;
  const outcomes: CaseOutcome[] = [];
  let status: FigmaStatus | undefined;

  try {
    await waitForSidecar(options.port);
    status = await preflight(options.port);

    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      channel: CHROME_PATH ? undefined : CHROME_CHANNEL,
      executablePath: CHROME_PATH,
      headless: true,
    });
    const context = await browser.newContext({ deviceScaleFactor: SCALE });
    const page = await context.newPage();

    await syncVariables(page, options.port);

    for (const entry of cases) {
      log(`case ${entry.id}…`);
      outcomes.push(await runCase(page, entry, options.port, runDir));
    }

    if (options.approveAll || options.approve.length > 0) {
      const approveSet = new Set(options.approve);
      for (const entry of cases) {
        if (options.approveAll || approveSet.has(entry.id)) {
          await approveCase(entry, runDir);
        }
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    sidecar.kill("SIGTERM");
  }

  const report: RunReport = {
    meta: {
      file: status?.info?.fileName,
      page: status?.info?.page,
      commit: gitCommit(),
      port: options.port,
      startedAt,
      durationMs: Date.now() - Date.parse(startedAt),
    },
    cases: outcomes,
  };
  await writeFile(resolve(runDir, "index.html"), renderReport(report), "utf8");

  const summary = summarize(outcomes);
  log(
    `done — ${summary.pass} pass, ${summary.fail} fail, ${summary.new} new, ${summary.error} error. Report: ${resolve(runDir, "index.html")}`,
  );

  if (summary.fail === 0 && summary.error === 0 && !options.keepResults) {
    // Keep NEW runs (they hold pulled.html to approve); prune clean passes.
    if (summary.new === 0) await rm(runDir, { recursive: true, force: true });
  }

  // Exit code gates on tier-1 failures only (spec); errors also signal trouble.
  process.exit(summary.fail > 0 || summary.error > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(
    `[fidelity] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
