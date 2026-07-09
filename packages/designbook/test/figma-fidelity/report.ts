/**
 * The fidelity run report (docs/specs/figma-sync-testing.md "Report"). Pure
 * string generation from the run outcomes → one self-contained HTML file
 * (`results/<run>/index.html`) a human reviews. No fs here; the runner writes
 * the returned string. `summarize` also drives the process exit code (tier-1
 * failures only).
 */

/** Per-case tier-1 (HTML equality) verdict. */
type Tier1Verdict = {
  /** Equal within tolerance (only meaningful when a baseline exists). */
  equal: boolean;
  mismatches: string[];
  /** Whether an approved `expected.html` existed for this run. */
  baseline: "approved" | "missing";
};

/** Per-case tier-2 (pixel) verdict — populated in P2. */
type Tier2Verdict = {
  mismatchPercent: number;
  threshold: number;
};

/** Per-case tier-3 (vision) verdict — populated with `--vision`. */
type Tier3Verdict = {
  same: boolean;
  differences: string[];
};

type CaseStatus = "pass" | "fail" | "new" | "error" | "skip";

type CaseOutcome = {
  id: string;
  note?: string;
  status: CaseStatus;
  tier1?: Tier1Verdict;
  pixel?: Tier2Verdict;
  vision?: Tier3Verdict;
  warnings: string[];
  /** Result-dir-relative image paths (present after a real run). */
  browserPng?: string;
  figmaPng?: string;
  diffPng?: string;
  /** Set when status === "error". */
  error?: string;
};

type RunMeta = {
  file?: string;
  page?: string;
  commit?: string;
  port: number;
  startedAt: string;
  durationMs: number;
};

type RunReport = {
  meta: RunMeta;
  cases: CaseOutcome[];
};

type Summary = {
  pass: number;
  fail: number;
  new: number;
  error: number;
  skip: number;
  total: number;
};

/** Tallies outcomes. `fail` is the ONLY count that gates the exit code. */
function summarize(cases: CaseOutcome[]): Summary {
  const summary: Summary = {
    pass: 0,
    fail: 0,
    new: 0,
    error: 0,
    skip: 0,
    total: cases.length,
  };
  for (const outcome of cases) summary[outcome.status]++;
  return summary;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_LABEL: Record<CaseStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  new: "NEW (approve)",
  error: "ERROR",
  skip: "skipped",
};

function thumb(path: string | undefined, label: string): string {
  if (!path) return `<span class="none">—</span>`;
  const src = escapeHtml(path);
  return `<a href="${src}" target="_blank"><img src="${src}" alt="${escapeHtml(label)}" loading="lazy" /></a>`;
}

function tier1Cell(outcome: CaseOutcome): string {
  if (!outcome.tier1) return `<span class="none">—</span>`;
  const { tier1 } = outcome;
  if (tier1.baseline === "missing") {
    return `<span class="new">no baseline — run <code>--approve ${escapeHtml(outcome.id)}</code></span>`;
  }
  if (tier1.equal) return `<span class="pass">equal</span>`;
  const first = tier1.mismatches[0] ?? "mismatch";
  const more =
    tier1.mismatches.length > 1
      ? `<div class="more">+${tier1.mismatches.length - 1} more</div>`
      : "";
  return `<span class="fail">${escapeHtml(first)}</span>${more}`;
}

function pixelCell(outcome: CaseOutcome): string {
  if (!outcome.pixel) return `<span class="none">—</span>`;
  const { mismatchPercent, threshold } = outcome.pixel;
  const over = mismatchPercent > threshold;
  const pct = mismatchPercent.toFixed(2);
  return `<span class="${over ? "warn" : "ok"}">${pct}%</span>`;
}

function visionCell(outcome: CaseOutcome): string {
  if (!outcome.vision) return `<span class="none">—</span>`;
  const { same, differences } = outcome.vision;
  if (same) return `<span class="pass">same</span>`;
  return `<span class="fail">${escapeHtml(differences.join("; ") || "differs")}</span>`;
}

function warningsCell(outcome: CaseOutcome): string {
  if (outcome.warnings.length === 0) return `<span class="none">—</span>`;
  return `<span class="warn" title="${escapeHtml(outcome.warnings.join("\n"))}">${outcome.warnings.length} warning(s)</span>`;
}

function caseRow(outcome: CaseOutcome): string {
  const note = outcome.note ? `<div class="note">${escapeHtml(outcome.note)}</div>` : "";
  const err = outcome.error
    ? `<div class="err">${escapeHtml(outcome.error)}</div>`
    : "";
  return `<tr class="status-${outcome.status}">
    <td><div class="id">${escapeHtml(outcome.id)}</div>${note}<div class="badge">${STATUS_LABEL[outcome.status]}</div>${err}</td>
    <td>${thumb(outcome.browserPng, "browser")}</td>
    <td>${thumb(outcome.figmaPng, "figma")}</td>
    <td>${thumb(outcome.diffPng, "diff")}${pixelCell(outcome)}</td>
    <td>${tier1Cell(outcome)}</td>
    <td>${visionCell(outcome)}</td>
    <td>${warningsCell(outcome)}</td>
  </tr>`;
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #888; margin-bottom: 16px; }
  .summary span { display: inline-block; margin-right: 12px; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  th, td { border: 1px solid #8884; padding: 8px; text-align: left; vertical-align: top; }
  th { background: #8881; position: sticky; top: 0; }
  img { max-width: 220px; max-height: 220px; border: 1px solid #8884; display: block; }
  .id { font-weight: 600; font-family: ui-monospace, monospace; }
  .note { color: #888; margin: 2px 0; }
  .badge { display: inline-block; margin-top: 4px; padding: 1px 6px; border-radius: 4px; font-size: 11px; background: #8882; }
  .pass, .ok { color: #16a34a; }
  .fail, .err { color: #dc2626; }
  .new { color: #2563eb; }
  .warn { color: #d97706; }
  .none { color: #aaa; }
  .more { color: #888; font-size: 11px; }
  tr.status-fail td:first-child, tr.status-error td:first-child { border-left: 3px solid #dc2626; }
  tr.status-pass td:first-child { border-left: 3px solid #16a34a; }
  tr.status-new td:first-child { border-left: 3px solid #2563eb; }
`;

/** Renders a full self-contained HTML report from a run's outcomes. */
function renderReport(report: RunReport): string {
  const s = summarize(report.cases);
  const meta = report.meta;
  const seconds = (meta.durationMs / 1000).toFixed(1);
  const metaLine = [
    meta.file ? `file: ${meta.file}` : undefined,
    meta.page ? `page: ${meta.page}` : undefined,
    meta.commit ? `commit: ${meta.commit}` : undefined,
    `port: ${meta.port}`,
    `${seconds}s`,
    meta.startedAt,
  ]
    .filter(Boolean)
    .map((part) => escapeHtml(String(part)))
    .join(" · ");

  const rows = report.cases.map(caseRow).join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Figma fidelity report</title>
<style>${STYLE}</style></head>
<body>
<h1>Figma fidelity report</h1>
<div class="meta">${metaLine}</div>
<div class="summary">
  <span class="pass">${s.pass} pass</span>
  <span class="fail">${s.fail} fail</span>
  <span class="new">${s.new} new</span>
  <span class="err">${s.error} error</span>
  <span class="none">${s.skip} skipped</span>
  <span>${s.total} total</span>
</div>
<table>
  <thead><tr>
    <th>Case</th><th>Browser</th><th>Figma</th><th>Diff / pixel</th>
    <th>Tier 1 (HTML)</th><th>Tier 3 (vision)</th><th>Push warnings</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</body></html>`;
}

export { renderReport, summarize, escapeHtml };
export type {
  RunReport,
  RunMeta,
  CaseOutcome,
  CaseStatus,
  Tier1Verdict,
  Tier2Verdict,
  Tier3Verdict,
  Summary,
};
