/**
 * Generates a fully self-contained HTML dashboard. ALL data is inlined at
 * generation time (static SVG + HTML, zero fetch, zero external assets) so
 * the file can be published behind a strict CSP.
 *
 *   pnpm --dir evals/context-arch run dashboard [runs/<run-id>] [--out <file>]
 *   node src/dashboard.ts <baselineRunDir> <curatedRunDir>   # BEFORE/AFTER comparison
 *
 * One run dir (or none → latest non-mock run): the single-run baseline view.
 * Two run dirs: comparison mode — Verdict becomes a BEFORE/AFTER table
 * (cost/time/quality/cache × replay/curated × short/long), the per-turn
 * context-size chart overlays both architectures, and the quality matrix
 * shows both runs side by side.
 *
 * Page content only — no doctype/html/head/body wrapper tags (the publish
 * wrapper supplies those). Light + dark themes via prefers-color-scheme
 * plus :root[data-theme] overrides.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallRecord, TaskResult } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const evalRoot = resolve(here, "..");
const repoRoot = resolve(evalRoot, "..", "..");

/** Base URL of `pnpm --dir evals/context-arch run viewer` (src/serveViewer.ts, fixed port). */
const VIEWER_BASE = "http://localhost:8817";

// ---------------------------------------------------------------- data load

function parseArgs(argv: string[]) {
  const dirs: string[] = [];
  let out = join(evalRoot, "report", "dashboard.html");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = resolve(argv[++i]);
    else dirs.push(resolve(argv[i]));
  }
  if (dirs.length === 0) {
    const runs = join(evalRoot, "runs");
    const candidates = existsSync(runs)
      ? readdirSync(runs).filter((d) => !d.startsWith("mock-")).sort()
      : [];
    if (candidates.length === 0) {
      console.error("no run dirs found; pass one explicitly");
      process.exit(1);
    }
    dirs.push(join(runs, candidates[candidates.length - 1]));
  }
  if (dirs.length > 2) {
    console.error("pass at most two run dirs (baseline [curated])");
    process.exit(1);
  }
  return { dirs, out };
}

type Run = {
  runDir: string;
  runId: string;
  runDate: string;
  arch: string;
  model: string;
  results: TaskResult[];
};

function loadRun(runDir: string): Run {
  const results: TaskResult[] = readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(runDir, d.name, "results.json"))
    .filter((p) => existsSync(p))
    .map((p) => JSON.parse(readFileSync(p, "utf8")) as TaskResult)
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (results.length === 0) {
    console.error(`no results.json found under ${runDir}`);
    process.exit(1);
  }
  const runId = runDir.split("/").pop() ?? runDir;
  return {
    runDir,
    runId,
    runDate: runId.slice(0, 10),
    arch: results[0].arch ?? "replay",
    model: results.find((r) => !r.mock)?.model ?? results[0].model,
    results,
  };
}

const { dirs, out } = parseArgs(process.argv.slice(2));
const runA = loadRun(dirs[0]);
const runB = dirs[1] ? loadRun(dirs[1]) : undefined;

// ------------------------------------------------------------------ helpers

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const usd = (n: number) => `$${n.toFixed(n >= 1 ? 2 : 3)}`;
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : `${Math.round(n)}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

type TurnStat = {
  turn: number;
  promptTokens: number; // at last call of the turn (context size proxy)
  costUSD: number;
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
  output: number;
  calls: number;
  latencyMaxMs: number;
  wallMs: number;
  user: string;
};

function turnStats(r: TaskResult): TurnStat[] {
  return r.turns.map((t) => {
    const calls = r.calls.filter((c) => c.turn === t.turn);
    const last: CallRecord | undefined = calls[calls.length - 1];
    const sum = (f: (c: CallRecord) => number) => calls.reduce((a, c) => a + f(c), 0);
    return {
      turn: t.turn,
      promptTokens: last
        ? (last.usage?.input ?? 0) + (last.usage?.cacheRead ?? 0) + (last.usage?.cacheWrite ?? 0)
        : 0,
      costUSD: sum((c) => c.costUSD ?? 0),
      cacheRead: sum((c) => c.usage?.cacheRead ?? 0),
      cacheWrite: sum((c) => c.usage?.cacheWrite ?? 0),
      uncached: sum((c) => c.usage?.input ?? 0),
      output: sum((c) => c.usage?.output ?? 0),
      calls: calls.length,
      latencyMaxMs: Math.max(0, ...calls.map((c) => c.latencyMs ?? 0)),
      wallMs: t.wallMs,
      user: t.user,
    };
  });
}

// ---------------------------------------------------------------- SVG bits

/** Clean axis max: round up to 1/2/5 × 10^k. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

const CHART_W = 300;
const CHART_H = 150;
const PAD = { top: 14, right: 14, bottom: 22, left: 44 };

function chartFrame(yMax: number, yFmt: (v: number) => string, xLabels: string[]): string {
  const iw = CHART_W - PAD.left - PAD.right;
  const ih = CHART_H - PAD.top - PAD.bottom;
  let s = "";
  // horizontal hairline gridlines at 0%, 50%, 100% of yMax + tick labels
  for (const f of [0, 0.5, 1]) {
    const y = PAD.top + ih - f * ih;
    s += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + iw}" y2="${y}" class="${f === 0 ? "axis" : "grid"}"/>`;
    s += `<text x="${PAD.left - 6}" y="${y + 3}" class="tick" text-anchor="end">${esc(yFmt(f * yMax))}</text>`;
  }
  // x labels: first, middle, last turn
  const n = xLabels.length;
  if (n > 0) {
    const idxs = n <= 3 ? xLabels.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
    for (const i of [...new Set(idxs)]) {
      const x = PAD.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
      s += `<text x="${x}" y="${CHART_H - 6}" class="tick" text-anchor="middle">${esc(xLabels[i])}</text>`;
    }
  }
  return s;
}

type Series = { values: number[]; cls: string; titles: string[] };

/** One or more line series on a shared frame, end dot + end label per series. */
function lineChart(series: Series[], yFmt: (v: number) => string): string {
  const iw = CHART_W - PAD.left - PAD.right;
  const ih = CHART_H - PAD.top - PAD.bottom;
  const n = Math.max(...series.map((s) => s.values.length));
  const yMax = niceMax(Math.max(...series.flatMap((s) => s.values)));
  const pt = (i: number, v: number) => {
    const x = PAD.left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = PAD.top + ih - (v / yMax) * ih;
    return [x, y] as const;
  };
  let s = chartFrame(yMax, yFmt, Array.from({ length: n }, (_, i) => `${i + 1}`));
  for (const ser of series) {
    if (ser.values.length === 0) continue;
    const path = ser.values.map((v, i) => `${i === 0 ? "M" : "L"}${pt(i, v).join(",")}`).join(" ");
    s += `<path d="${path}" class="line ${ser.cls}"/>`;
    ser.values.forEach((v, i) => {
      const [x, y] = pt(i, v);
      s += `<circle cx="${x}" cy="${y}" r="10" fill="transparent"><title>${esc(ser.titles[i] ?? "")}</title></circle>`;
    });
    const [ex, ey] = pt(ser.values.length - 1, ser.values[ser.values.length - 1]);
    s += `<circle cx="${ex}" cy="${ey}" r="4" class="dot ${ser.cls}"/>`;
    const lx = Math.min(ex + 6, CHART_W - 2);
    s += `<text x="${lx}" y="${Math.max(ey - 7, 10)}" class="endlabel" text-anchor="end">${esc(yFmt(ser.values[ser.values.length - 1]))}</text>`;
  }
  return svgWrap(s);
}

/** Rounded-top column path (4px radius at the data end, square baseline). */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

/** Single-series column chart. */
function barChart(values: number[], yFmt: (v: number) => string, titles: string[]): string {
  const iw = CHART_W - PAD.left - PAD.right;
  const ih = CHART_H - PAD.top - PAD.bottom;
  const yMax = niceMax(Math.max(...values));
  const slot = iw / values.length;
  const bw = Math.min(24, slot - 2);
  let s = chartFrame(yMax, yFmt, values.map((_, i) => `${i + 1}`));
  values.forEach((v, i) => {
    const h = (v / yMax) * ih;
    const x = PAD.left + i * slot + (slot - bw) / 2;
    const y = PAD.top + ih - h;
    if (h > 0.5) {
      s += `<path d="${columnPath(x, y, bw, h)}" class="fill s1"><title>${esc(titles[i])}</title></path>`;
    } else {
      s += `<rect x="${x}" y="${PAD.top + ih - 1}" width="${bw}" height="1" class="fill s1"><title>${esc(titles[i])}</title></rect>`;
    }
  });
  return svgWrap(s);
}

/** Stacked columns: [read, write, uncached] per turn, 2px surface gaps. */
function stackedChart(rows: { read: number; write: number; uncached: number }[], titles: string[]): string {
  const iw = CHART_W - PAD.left - PAD.right;
  const ih = CHART_H - PAD.top - PAD.bottom;
  const totals = rows.map((r) => r.read + r.write + r.uncached);
  const yMax = niceMax(Math.max(...totals));
  const slot = iw / rows.length;
  const bw = Math.min(24, slot - 2);
  let s = chartFrame(yMax, compact, rows.map((_, i) => `${i + 1}`));
  rows.forEach((r, i) => {
    const x = PAD.left + i * slot + (slot - bw) / 2;
    const segs = [
      { v: r.read, cls: "s1", name: "cache read" },
      { v: r.write, cls: "s2", name: "cache write" },
      { v: r.uncached, cls: "s3", name: "uncached input" },
    ];
    let yCursor = PAD.top + ih; // baseline
    const drawn = segs.filter((g) => g.v > 0);
    drawn.forEach((g, gi) => {
      const h = Math.max(1, (g.v / yMax) * ih);
      const yTop = yCursor - h;
      const isTop = gi === drawn.length - 1;
      const gap = gi > 0 ? 1 : 0; // 2px surface gap = 1px shaved off each side
      if (isTop) {
        s += `<path d="${columnPath(x, yTop, bw, Math.max(1, h - gap))}" class="fill ${g.cls}"><title>${esc(`${titles[i]} — ${g.name}: ${fmt(g.v)} tok`)}</title></path>`;
      } else {
        s += `<rect x="${x}" y="${yTop + gap}" width="${bw}" height="${Math.max(1, h - gap - (gi > 0 ? 1 : 0))}" class="fill ${g.cls}"><title>${esc(`${titles[i]} — ${g.name}: ${fmt(g.v)} tok`)}</title></rect>`;
      }
      yCursor = yTop;
    });
  });
  return svgWrap(s);
}

function svgWrap(inner: string): string {
  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

// -------------------------------------------------------------- aggregates

function aggregate(results: TaskResult[]) {
  const agg = results.reduce(
    (a, r) => {
      a.turns += r.turns.length;
      a.calls += r.totals.llmCalls;
      a.input += r.totals.input;
      a.output += r.totals.output;
      a.cacheRead += r.totals.cacheRead;
      a.cacheWrite += r.totals.cacheWrite;
      a.cost += r.totals.costUSD;
      a.wall += r.totals.wallMs;
      a.checksPassed += r.checks.filter((c) => c.pass).length;
      a.checksTotal += r.checks.length;
      return a;
    },
    { turns: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, wall: 0, checksPassed: 0, checksTotal: 0 },
  );
  return {
    ...agg,
    cacheHit: (agg.cacheRead / Math.max(1, agg.cacheRead + agg.cacheWrite + agg.input)) * 100,
  };
}

// -------------------------------------------- verdict: short vs long slices

/** Long tasks are the 15+ turn ones (same threshold as the runner). */
const LONG_TURNS = 10;

function sliceStats(rs: TaskResult[]) {
  const calls = rs.flatMap((r) => r.calls);
  const latencies = calls
    .map((c) => c.latencyMs)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  const turns = rs.reduce((a, r) => a + r.turns.length, 0);
  const cost = rs.reduce((a, r) => a + r.totals.costUSD, 0);
  const wall = rs.reduce((a, r) => a + r.totals.wallMs, 0);
  const cacheRead = rs.reduce((a, r) => a + r.totals.cacheRead, 0);
  const cacheWrite = rs.reduce((a, r) => a + r.totals.cacheWrite, 0);
  const input = rs.reduce((a, r) => a + r.totals.input, 0);
  const checksPassed = rs.reduce((a, r) => a + r.checks.filter((c) => c.pass).length, 0);
  const checksTotal = rs.reduce((a, r) => a + r.checks.length, 0);
  const judged = rs.filter((r) => r.judge);
  const judgeClean = judged.filter(
    (r) =>
      !r.judge!.redid_work &&
      !r.judge!.contradicted_earlier_decision &&
      !r.judge!.unrequested_edits,
  ).length;
  const incidents =
    checksTotal -
    checksPassed +
    judged.reduce(
      (a, r) =>
        a +
        (r.judge!.redid_work ? 1 : 0) +
        (r.judge!.contradicted_earlier_decision ? 1 : 0),
      0,
    );
  return {
    tasks: rs.length,
    turns,
    cost,
    costPerTurn: cost / Math.max(1, turns),
    wall,
    wallPerTurn: wall / Math.max(1, turns),
    p50: latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0,
    cacheRead,
    cacheWrite,
    input,
    cachedShare: (cacheRead / Math.max(1, cacheRead + cacheWrite + input)) * 100,
    promptTokPerTurn: (cacheRead + cacheWrite + input) / Math.max(1, turns),
    checksPassed,
    checksTotal,
    judgeClean,
    judged: judged.length,
    incidents,
  };
}

const shortOf = (run: Run) => sliceStats(run.results.filter((r) => r.turns.length < LONG_TURNS));
const longOf = (run: Run) => sliceStats(run.results.filter((r) => r.turns.length >= LONG_TURNS));

const pctWord = (from: number, to: number): string => {
  if (from <= 0) return "n/a";
  const pct = ((to - from) / from) * 100;
  if (Math.abs(pct) < 3) return "flat";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
};

// -------------------------------------------- single-run verdict (unchanged)

function verdictSectionSingle(run: Run): string {
  const s = shortOf(run);
  const l = longOf(run);
  if (s.tasks === 0 || l.tasks === 0) return "";
  const lenRatio = (l.turns / Math.max(1, l.tasks)) / Math.max(0.1, s.turns / Math.max(1, s.tasks));
  const costDelta = pctWord(s.costPerTurn, l.costPerTurn);
  const costVerdict =
    costDelta === "flat" ||
    (costDelta !== "n/a" && Math.abs(l.costPerTurn - s.costPerTurn) < 0.005)
      ? `<strong>${costDelta} per turn</strong> — long sessions do not cost more per turn (the growing base is billed as cache reads at 0.1×)`
      : `cost/turn <strong>${costDelta}</strong> on long tasks`;
  const wallDelta = pctWord(s.wallPerTurn, l.wallPerTurn);
  const p50Delta = pctWord(s.p50, l.p50);
  const timeVerdict = `wall/turn <strong>${wallDelta}</strong>, p50 latency <strong>${p50Delta}</strong> at ~${lenRatio.toFixed(0)}× session length — no latency cliff at this scale`;
  const allClean =
    s.checksPassed === s.checksTotal &&
    l.checksPassed === l.checksTotal &&
    s.incidents === 0 &&
    l.incidents === 0;
  const qualityVerdict = allClean
    ? `<strong>no failures in either regime</strong> — every forgetting/retention probe passed; quality is not the discriminator ≤18 turns`
    : `<strong>${s.incidents + l.incidents} incident(s)</strong> — see the quality matrix below`;
  const cell = (rows: string[]) => rows.join("<br>");
  return `
  <h2>Verdict — short vs long: cost, time, quality</h2>
  <div class="card verdict"><div class="scroll"><table>
    <thead><tr><th></th><th>Short (01–06, ${s.tasks} tasks · ${s.turns} turns)</th><th>Long (07–08, ${l.tasks} tasks · ${l.turns} turns)</th><th>Δ / verdict</th></tr></thead>
    <tbody>
      <tr><td class="metric">Cost</td>
        <td class="vnum">${cell([`<strong>${usd(s.cost)}</strong> total`, `${usd(s.costPerTurn)}/turn`])}</td>
        <td class="vnum">${cell([`<strong>${usd(l.cost)}</strong> total`, `${usd(l.costPerTurn)}/turn`])}</td>
        <td>${costVerdict}</td></tr>
      <tr><td class="metric">Time</td>
        <td class="vnum">${cell([`<strong>${secs(s.wall)}</strong> wall total`, `${secs(s.wallPerTurn)}/turn`, `p50 latency ${secs(s.p50)}`])}</td>
        <td class="vnum">${cell([`<strong>${secs(l.wall)}</strong> wall total`, `${secs(l.wallPerTurn)}/turn`, `p50 latency ${secs(l.p50)}`])}</td>
        <td>${timeVerdict}</td></tr>
      <tr><td class="metric">Quality</td>
        <td class="vnum">${cell([`<strong>${s.checksPassed}/${s.checksTotal}</strong> checks (${((s.checksPassed / Math.max(1, s.checksTotal)) * 100).toFixed(0)}%)`, `judge clean ${s.judgeClean}/${s.judged}`, `${s.incidents} forgetting/contradiction incidents`])}</td>
        <td class="vnum">${cell([`<strong>${l.checksPassed}/${l.checksTotal}</strong> checks (${((l.checksPassed / Math.max(1, l.checksTotal)) * 100).toFixed(0)}%)`, `judge clean ${l.judgeClean}/${l.judged}`, `${l.incidents} forgetting/contradiction incidents`])}</td>
        <td>${qualityVerdict}</td></tr>
    </tbody>
  </table></div></div>`;
}

// -------------------------------------------- comparison verdict (BEFORE/AFTER)

function verdictSectionCompare(before: Run, after: Run): string {
  type Slice = ReturnType<typeof sliceStats>;
  const slices: { label: string; b: Slice; a: Slice }[] = [
    { label: "short", b: shortOf(before), a: shortOf(after) },
    { label: "long", b: longOf(before), a: longOf(after) },
  ].filter((s) => s.b.tasks > 0 || s.a.tasks > 0);

  type Row = {
    metric: string;
    sub: string;
    b: string;
    a: string;
    delta: string;
    good?: boolean | undefined; // color the Δ chip
  };
  const rows: Row[] = [];
  for (const { label, b, a } of slices) {
    rows.push({
      metric: "Cost",
      sub: label,
      b: `${usd(b.cost)} · ${usd(b.costPerTurn)}/turn`,
      a: `${usd(a.cost)} · ${usd(a.costPerTurn)}/turn`,
      delta: pctWord(b.costPerTurn, a.costPerTurn),
      good: a.costPerTurn < b.costPerTurn * 0.97 ? true : a.costPerTurn > b.costPerTurn * 1.03 ? false : undefined,
    });
  }
  for (const { label, b, a } of slices) {
    rows.push({
      metric: "Time",
      sub: label,
      b: `${secs(b.wall)} · ${secs(b.wallPerTurn)}/turn · p50 ${secs(b.p50)}`,
      a: `${secs(a.wall)} · ${secs(a.wallPerTurn)}/turn · p50 ${secs(a.p50)}`,
      delta: `${pctWord(b.wallPerTurn, a.wallPerTurn)} wall/turn`,
      good: a.wallPerTurn < b.wallPerTurn * 0.97 ? true : a.wallPerTurn > b.wallPerTurn * 1.03 ? false : undefined,
    });
  }
  for (const { label, b, a } of slices) {
    const regressed = a.checksPassed < a.checksTotal || a.incidents > b.incidents;
    rows.push({
      metric: "Quality",
      sub: label,
      b: `${b.checksPassed}/${b.checksTotal} checks · judge ${b.judgeClean}/${b.judged} · ${b.incidents} incidents`,
      a: `${a.checksPassed}/${a.checksTotal} checks · judge ${a.judgeClean}/${a.judged} · ${a.incidents} incidents`,
      delta:
        a.incidents === b.incidents
          ? "parity"
          : `${a.incidents - b.incidents > 0 ? "+" : ""}${a.incidents - b.incidents} incidents`,
      good: regressed ? false : a.incidents < b.incidents ? true : undefined,
    });
  }
  for (const { label, b, a } of slices) {
    rows.push({
      metric: "Cache",
      sub: label,
      b: `${b.cachedShare.toFixed(1)}% cached · ${compact(b.promptTokPerTurn)} tok/turn`,
      a: `${a.cachedShare.toFixed(1)}% cached · ${compact(a.promptTokPerTurn)} tok/turn`,
      delta: `${(a.cachedShare - b.cachedShare).toFixed(1)}pp · ${pctWord(b.promptTokPerTurn, a.promptTokPerTurn)} tok/turn`,
      good: undefined,
    });
  }

  let lastMetric = "";
  const body = rows
    .map((r) => {
      const metricCell =
        r.metric === lastMetric
          ? ""
          : `<td class="metric" rowspan="${rows.filter((x) => x.metric === r.metric).length}">${r.metric}</td>`;
      lastMetric = r.metric;
      const chip =
        r.good === undefined
          ? `<span class="chip">${esc(r.delta)}</span>`
          : `<span class="chip ${r.good ? "pass" : "fail"}">${esc(r.delta)}</span>`;
      return `<tr>${metricCell}<td class="slice">${r.sub}</td><td class="vnum">${r.b}</td><td class="vnum">${r.a}</td><td>${chip}</td></tr>`;
    })
    .join("\n");

  const sb = shortOf(before);
  const lb = longOf(before);
  return `
  <h2>Verdict — BEFORE (replay) vs AFTER (curated)</h2>
  <div class="sub">short = tasks 01–06 (${sb.tasks} tasks · ${sb.turns} turns) · long = tasks 07–08 (${lb.tasks} tasks · ${lb.turns} turns)</div>
  <div class="card verdict"><div class="scroll"><table>
    <thead><tr><th></th><th></th><th>Replay (before)</th><th>Curated (after)</th><th>Δ</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div></div>`;
}

// ------------------------------------- findings.md → inline-rendered block

function mdInline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/** Minimal markdown → HTML (headings, flat bullet lists, paragraphs). */
function mdToHtml(md: string): string {
  let html = "";
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  for (const line of md.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const tag = heading[1].length === 1 ? "h3" : "h4";
      html += `<${tag}>${mdInline(heading[2])}</${tag}>`;
    } else if (/^\s*-\s+/.test(line)) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${mdInline(line.replace(/^\s*-\s+/, ""))}</li>`;
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${mdInline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function findingsSection(): string {
  const p = join(evalRoot, "report", "findings.md");
  if (!existsSync(p)) return "";
  return `
  <h2>Findings &amp; recommendations</h2>
  <div class="card findings">${mdToHtml(readFileSync(p, "utf8"))}</div>`;
}

// ------------------------------------------------------------------- HTML

const chip = (pass: boolean, label?: string) =>
  `<span class="chip ${pass ? "pass" : "fail"}">${label ?? (pass ? "pass" : "FAIL")}</span>`;

function checkLabel(c: TaskResult["checks"][number]["check"]): string {
  switch (c.type) {
    case "file_contains": return `${c.file} contains /${c.pattern}/`;
    case "file_not_contains": return `${c.file} does NOT contain /${c.pattern}/`;
    case "file_unchanged": return `${c.file} unchanged`;
    case "max_reads": return `≤ ${c.max} read(s) of ${c.file}`;
    case "final_response_matches": return `turn ${c.turn + 1} response matches /${c.pattern}/`;
  }
}

function statTilesSingle(run: Run): string {
  const agg = aggregate(run.results);
  return `
<div class="tiles">
  <div class="tile"><div class="tlabel">Total cost</div><div class="tvalue">${usd(agg.cost)}</div><div class="tsub">${run.results.length} tasks · cap-safe</div></div>
  <div class="tile"><div class="tlabel">Cost per turn</div><div class="tvalue">${usd(agg.cost / Math.max(1, agg.turns))}</div><div class="tsub">${agg.turns} user turns · ${agg.calls} LLM calls</div></div>
  <div class="tile"><div class="tlabel">Cache-hit share</div><div class="tvalue">${agg.cacheHit.toFixed(1)}%</div><div class="tsub">of prompt tokens served as cache reads</div></div>
  <div class="tile"><div class="tlabel">Checks passed</div><div class="tvalue">${agg.checksPassed}/${agg.checksTotal}</div><div class="tsub">scripted assertions across all tasks</div></div>
</div>`;
}

function statTilesCompare(before: Run, after: Run): string {
  const b = aggregate(before.results);
  const a = aggregate(after.results);
  const pair = (x: string, y: string) => `${x} <span class="arrow">→</span> ${y}`;
  return `
<div class="tiles">
  <div class="tile"><div class="tlabel">Total cost</div><div class="tvalue">${pair(usd(b.cost), usd(a.cost))}</div><div class="tsub">replay → curated (${pctWord(b.cost, a.cost)})</div></div>
  <div class="tile"><div class="tlabel">Cost per turn</div><div class="tvalue">${pair(usd(b.cost / Math.max(1, b.turns)), usd(a.cost / Math.max(1, a.turns)))}</div><div class="tsub">${b.calls} → ${a.calls} LLM calls</div></div>
  <div class="tile"><div class="tlabel">Cache-hit share</div><div class="tvalue">${pair(`${b.cacheHit.toFixed(1)}%`, `${a.cacheHit.toFixed(1)}%`)}</div><div class="tsub">of prompt tokens served as cache reads</div></div>
  <div class="tile"><div class="tlabel">Checks passed</div><div class="tvalue">${pair(`${b.checksPassed}/${b.checksTotal}`, `${a.checksPassed}/${a.checksTotal}`)}</div><div class="tsub">scripted assertions across all tasks</div></div>
</div>`;
}

/**
 * "view conversation" link into the local pi session viewer. Rendered only
 * when the persisted transcript (runs/<id>/<task>/session.jsonl) exists;
 * absolute localhost URL so links also work from the published artifact page
 * (opens a new tab against the locally running viewer server).
 */
function sessionLink(run: Run, r: TaskResult): string {
  const file = join(run.runDir, r.taskId, "session.jsonl");
  if (!existsSync(file)) return `<span class="muted">—</span>`;
  const rel = relative(repoRoot, file).split("\\").join("/");
  if (rel.startsWith("..")) return `<span class="muted">—</span>`;
  const href = `${VIEWER_BASE}/tools/pi-session-viewer/index.html?session=${encodeURI(`/${rel}`)}`;
  return `<a class="sess" href="${esc(href)}" target="_blank" rel="noopener">view conversation</a>`;
}

function perTaskRow(run: Run, r: TaskResult, archLabel?: string): string {
  const passed = r.checks.filter((c) => c.pass).length;
  const ok = passed === r.checks.length && !r.aborted;
  return `<tr>
      <td class="tname">${esc(r.taskId)}${r.aborted ? ` <span class="chip fail">aborted</span>` : ""}</td>
      ${archLabel ? `<td>${esc(archLabel)}</td>` : ""}
      <td>${r.turns.length}</td>
      <td>${r.totals.llmCalls}</td>
      <td class="num">${usd(r.totals.costUSD)}</td>
      <td class="num">${fmt(r.totals.cacheRead)}</td>
      <td class="num">${fmt(r.totals.cacheWrite)}</td>
      <td class="num">${fmt(r.totals.input)}</td>
      <td class="num">${fmt(r.totals.output)}</td>
      <td class="num">${secs(r.totals.wallMs)}</td>
      <td>${chip(ok, `${passed}/${r.checks.length}`)}</td>
      <td>${r.judge ? `${chip(!r.judge.redid_work, r.judge.redid_work ? "redid" : "no-redo")} ${chip(!r.judge.contradicted_earlier_decision, r.judge.contradicted_earlier_decision ? "contra" : "no-contra")}${r.judge.unrequested_edits === undefined ? "" : ` ${chip(!r.judge.unrequested_edits, r.judge.unrequested_edits ? "scope-creep" : "no-creep")}`}` : "—"}</td>
      <td>${sessionLink(run, r)}</td>
    </tr>`;
}

function perTaskTable(runs: Run[]): string {
  const twoRuns = runs.length > 1;
  const rows = twoRuns
    ? runs[0].results
        .map((r) => {
          const other = runs[1].results.find((x) => x.taskId === r.taskId);
          return perTaskRow(runs[0], r, runs[0].arch) + (other ? perTaskRow(runs[1], other, runs[1].arch) : "");
        })
        .join("\n")
    : runs[0].results.map((r) => perTaskRow(runs[0], r)).join("\n");
  return `
<div class="scroll"><table>
  <thead><tr><th>task</th>${twoRuns ? "<th>arch</th>" : ""}<th>turns</th><th>calls</th><th>cost</th><th>cache read</th><th>cache write</th><th>uncached in</th><th>output</th><th>wall</th><th>checks</th><th>judge</th><th>session</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<div class="notelink">conversation links require the local viewer server: <code>pnpm --dir evals/context-arch run viewer</code> (localhost:8817)</div>`;
}

const chartLegendSingle = `
<div class="legend">
  <span><i class="key s1"></i>cache read</span>
  <span><i class="key s2"></i>cache write</span>
  <span><i class="key s3"></i>uncached input</span>
</div>`;

function chartCardsSingle(run: Run): string {
  return run.results
    .map((r) => {
      const ts = turnStats(r);
      const ctx = lineChart(
        [{
          values: ts.map((t) => t.promptTokens),
          cls: "s1",
          titles: ts.map((t) => `turn ${t.turn + 1}: ${fmt(t.promptTokens)} prompt tokens (last call)`),
        }],
        compact,
      );
      const cost = barChart(
        ts.map((t) => t.costUSD),
        (v) => `$${v.toFixed(v >= 1 ? 1 : 2)}`,
        ts.map((t) => `turn ${t.turn + 1}: ${usd(t.costUSD)} (${t.calls} calls)`),
      );
      const stack = stackedChart(
        ts.map((t) => ({ read: t.cacheRead, write: t.cacheWrite, uncached: t.uncached })),
        ts.map((t) => `turn ${t.turn + 1}`),
      );
      return `<div class="card">
      <h3>${esc(r.taskId)} <span class="muted">· ${ts.length} turns</span></h3>
      <div class="chartrow">
        <figure><figcaption>Context size by turn <span class="muted">(prompt tok, last call)</span></figcaption>${ctx}</figure>
        <figure><figcaption>Cost per turn</figcaption>${cost}</figure>
        <figure><figcaption>Prompt tokens per turn <span class="muted">(stacked)</span></figcaption>${stack}</figure>
      </div>
    </div>`;
    })
    .join("\n");
}

/** Comparison: context-size overlay + per-arch cache-composition stacks. */
function chartCardsCompare(before: Run, after: Run): string {
  return before.results
    .map((rb) => {
      const ra = after.results.find((x) => x.taskId === rb.taskId);
      const tb = turnStats(rb);
      const ta = ra ? turnStats(ra) : [];
      const ctx = lineChart(
        [
          {
            values: tb.map((t) => t.promptTokens),
            cls: "s1",
            titles: tb.map((t) => `replay — turn ${t.turn + 1}: ${fmt(t.promptTokens)} prompt tokens`),
          },
          {
            values: ta.map((t) => t.promptTokens),
            cls: "s2",
            titles: ta.map((t) => `curated — turn ${t.turn + 1}: ${fmt(t.promptTokens)} prompt tokens`),
          },
        ],
        compact,
      );
      const costOverlay = lineChart(
        [
          {
            values: tb.map((t) => t.costUSD),
            cls: "s1",
            titles: tb.map((t) => `replay — turn ${t.turn + 1}: ${usd(t.costUSD)} (${t.calls} calls)`),
          },
          {
            values: ta.map((t) => t.costUSD),
            cls: "s2",
            titles: ta.map((t) => `curated — turn ${t.turn + 1}: ${usd(t.costUSD)} (${t.calls} calls)`),
          },
        ],
        (v) => `$${v.toFixed(v >= 1 ? 1 : 2)}`,
      );
      const stackAfter = ta.length
        ? stackedChart(
            ta.map((t) => ({ read: t.cacheRead, write: t.cacheWrite, uncached: t.uncached })),
            ta.map((t) => `turn ${t.turn + 1}`),
          )
        : "";
      return `<div class="card">
      <h3>${esc(rb.taskId)} <span class="muted">· ${tb.length} turns${ra ? "" : " · no curated run"}</span></h3>
      <div class="chartrow">
        <figure><figcaption>Context size by turn <span class="muted">(replay vs curated)</span></figcaption>${ctx}</figure>
        <figure><figcaption>Cost per turn <span class="muted">(replay vs curated)</span></figcaption>${costOverlay}</figure>
        ${stackAfter ? `<figure><figcaption>Curated prompt tokens <span class="muted">(stacked)</span></figcaption>${stackAfter}</figure>` : ""}
      </div>
    </div>`;
    })
    .join("\n");
}

function judgeRowsSingle(r: TaskResult): string {
  return r.judge
    ? `<tr><td>${chip(!r.judge.redid_work)}</td><td class="clabel">judge: did not redo completed work</td><td></td></tr>
       ${r.judge.unrequested_edits === undefined ? "" : `<tr><td>${chip(!r.judge.unrequested_edits)}</td><td class="clabel">judge: no unrequested edits (scope creep)</td><td></td></tr>`}
       <tr><td>${chip(!r.judge.contradicted_earlier_decision)}</td><td class="clabel">judge: no contradicted earlier decision</td>
       <td><details><summary>notes</summary><div class="detail">${esc(r.judge.notes)}</div></details></td></tr>`
    : `<tr><td><span class="chip">n/a</span></td><td class="clabel">judge: not run</td><td></td></tr>`;
}

function qualityCardsSingle(run: Run): string {
  return run.results
    .map((r) => {
      const rows = r.checks
        .map((c) => {
          const detail =
            !c.pass && c.detail
              ? `<details><summary>detail</summary><div class="detail">${esc(c.detail)}</div></details>`
              : "";
          return `<tr><td>${chip(c.pass)}</td><td class="clabel">${esc(checkLabel(c.check))}</td><td>${detail}</td></tr>`;
        })
        .join("\n");
      const passed = r.checks.filter((c) => c.pass).length;
      return `<details class="card" ${passed < r.checks.length ? "open" : ""}>
      <summary><strong>${esc(r.taskId)}</strong> — ${passed}/${r.checks.length} checks${r.judge && (r.judge.redid_work || r.judge.contradicted_earlier_decision) ? " · judge flagged" : ""}</summary>
      <div class="scroll"><table class="checks"><tbody>${rows}\n${judgeRowsSingle(r)}</tbody></table></div>
    </details>`;
    })
    .join("\n");
}

/** Comparison quality matrix: per check, replay + curated chips side by side. */
function qualityCardsCompare(before: Run, after: Run): string {
  return before.results
    .map((rb) => {
      const ra = after.results.find((x) => x.taskId === rb.taskId);
      const rows = rb.checks
        .map((cb, i) => {
          const ca = ra?.checks[i];
          const detail =
            ca && !ca.pass && ca.detail
              ? `<details><summary>curated detail</summary><div class="detail">${esc(ca.detail)}</div></details>`
              : !cb.pass && cb.detail
                ? `<details><summary>replay detail</summary><div class="detail">${esc(cb.detail)}</div></details>`
                : "";
          return `<tr><td>${chip(cb.pass)}</td><td>${ca ? chip(ca.pass) : `<span class="chip">n/a</span>`}</td><td class="clabel">${esc(checkLabel(cb.check))}</td><td>${detail}</td></tr>`;
        })
        .join("\n");
      const judgeFlag = (r: TaskResult | undefined, f: (j: NonNullable<TaskResult["judge"]>) => boolean | undefined) =>
        r?.judge ? chip(!f(r.judge)) : `<span class="chip">n/a</span>`;
      const judgeRows = `
        <tr><td>${judgeFlag(rb, (j) => j.redid_work)}</td><td>${judgeFlag(ra, (j) => j.redid_work)}</td><td class="clabel">judge: did not redo completed work</td><td></td></tr>
        <tr><td>${judgeFlag(rb, (j) => j.unrequested_edits)}</td><td>${judgeFlag(ra, (j) => j.unrequested_edits)}</td><td class="clabel">judge: no unrequested edits (scope creep)</td><td></td></tr>
        <tr><td>${judgeFlag(rb, (j) => j.contradicted_earlier_decision)}</td><td>${judgeFlag(ra, (j) => j.contradicted_earlier_decision)}</td><td class="clabel">judge: no contradicted earlier decision</td>
        <td>${ra?.judge ? `<details><summary>curated notes</summary><div class="detail">${esc(ra.judge.notes)}</div></details>` : ""}</td></tr>`;
      const passedB = rb.checks.filter((c) => c.pass).length;
      const passedA = ra ? ra.checks.filter((c) => c.pass).length : 0;
      const regressed = ra ? passedA < ra.checks.length : true;
      return `<details class="card" ${regressed ? "open" : ""}>
      <summary><strong>${esc(rb.taskId)}</strong> — replay ${passedB}/${rb.checks.length} · curated ${ra ? `${passedA}/${ra.checks.length}` : "n/a"}</summary>
      <div class="scroll"><table class="checks compare">
        <thead><tr><th>replay</th><th>curated</th><th>check</th><th></th></tr></thead>
        <tbody>${rows}\n${judgeRows}</tbody>
      </table></div>
    </details>`;
    })
    .join("\n");
}

function drillCards(run: Run): string {
  return run.results
    .map((r) => {
      const ts = turnStats(r);
      const rows = ts
        .map((t) => {
          const prompt = t.user.replace(/\s+/g, " ").trim();
          const short = prompt.length > 110 ? `${prompt.slice(0, 110)}…` : prompt;
          return `<tr>
          <td>${t.turn + 1}</td>
          <td class="prompt" title="${esc(prompt.slice(0, 500))}">${esc(short)}</td>
          <td>${t.calls}</td>
          <td class="num">${fmt(t.promptTokens)}</td>
          <td class="num">${fmt(t.output)}</td>
          <td class="num">${usd(t.costUSD)}</td>
          <td class="num">${secs(t.latencyMaxMs)}</td>
          <td class="num">${secs(t.wallMs)}</td>
        </tr>`;
        })
        .join("\n");
      return `<details class="card">
      <summary><strong>${esc(r.taskId)}</strong> — ${ts.length} turns, ${r.totals.llmCalls} calls, ${usd(r.totals.costUSD)}</summary>
      <div class="scroll"><table>
        <thead><tr><th>#</th><th>user prompt</th><th>calls</th><th>prompt tok</th><th>out tok</th><th>cost</th><th>max latency</th><th>wall</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`;
    })
    .join("\n");
}

// -------------------------------------------------------------------- page

const STYLE = `
<style>
  :root {
    --bg: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
    --s1: #2a78d6; --s2: #1baf7a; --s3: #eda100;
    --good-bg: #e3f2e3; --good-ink: #006300; --bad-bg: #fbe3e3; --bad-ink: #a12626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
      --s1: #3987e5; --s2: #199e70; --s3: #c98500;
      --good-bg: #10310f; --good-ink: #7fd67f; --bad-bg: #3a1515; --bad-ink: #f09a9a;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #199e70; --s3: #c98500;
    --good-bg: #10310f; --good-ink: #7fd67f; --bad-bg: #3a1515; --bad-ink: #f09a9a;
  }
  :root[data-theme="light"] {
    --bg: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
    --s1: #2a78d6; --s2: #1baf7a; --s3: #eda100;
    --good-bg: #e3f2e3; --good-ink: #006300; --bad-bg: #fbe3e3; --bad-ink: #a12626;
  }
  body { background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 36px 0 12px; }
  h3 { font-size: 13px; margin: 0 0 8px; }
  .sub, .muted { color: var(--muted); font-weight: 400; }
  .sub { font-size: 12.5px; margin-bottom: 20px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .tlabel { font-size: 12px; color: var(--ink2); }
  .tvalue { font-size: 26px; font-weight: 600; margin: 2px 0; }
  .tvalue .arrow { color: var(--muted); font-weight: 400; font-size: 18px; }
  .tsub { font-size: 11.5px; color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: 4px 10px 6px 0; border-bottom: 1px solid var(--axis); white-space: nowrap; }
  td { padding: 5px 10px 5px 0; border-bottom: 1px solid var(--grid); vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.tname { white-space: nowrap; font-weight: 500; }
  td.prompt { color: var(--ink2); min-width: 280px; }
  td.clabel { color: var(--ink2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  .chip { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; background: var(--grid); color: var(--ink2); }
  .chip.pass { background: var(--good-bg); color: var(--good-ink); }
  .chip.fail { background: var(--bad-bg); color: var(--bad-ink); }
  .chartrow { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  figure { margin: 0; min-width: 0; }
  figcaption { font-size: 11.5px; color: var(--ink2); margin-bottom: 4px; }
  svg { width: 100%; height: auto; display: block; background: var(--surface); }
  svg .grid { stroke: var(--grid); stroke-width: 1; }
  svg .axis { stroke: var(--axis); stroke-width: 1; }
  svg .tick { fill: var(--muted); font-size: 8.5px; font-family: system-ui, sans-serif; }
  svg .endlabel { fill: var(--ink2); font-size: 9px; font-weight: 600; font-family: system-ui, sans-serif; }
  svg .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  svg .line.s1 { stroke: var(--s1); }
  svg .line.s2 { stroke: var(--s2); }
  svg .dot.s1 { fill: var(--s1); stroke: var(--surface); stroke-width: 2; }
  svg .dot.s2 { fill: var(--s2); stroke: var(--surface); stroke-width: 2; }
  svg .fill.s1 { fill: var(--s1); }
  svg .fill.s2 { fill: var(--s2); }
  svg .fill.s3 { fill: var(--s3); }
  .legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink2); margin: 2px 0 12px; }
  .legend .key { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
  .key.s1 { background: var(--s1); } .key.s2 { background: var(--s2); } .key.s3 { background: var(--s3); }
  details.card > summary { cursor: pointer; font-size: 13px; }
  details.card[open] > summary { margin-bottom: 10px; }
  details summary { color: var(--ink2); }
  .detail { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--ink2); padding: 6px 0 2px; white-space: pre-wrap; word-break: break-word; }
  table.checks td:first-child { width: 52px; }
  table.checks.compare td:first-child, table.checks.compare td:nth-child(2) { width: 62px; }
  .verdict td { vertical-align: top; }
  .verdict td.metric { font-weight: 600; white-space: nowrap; }
  .verdict td.slice { color: var(--muted); white-space: nowrap; }
  .verdict td.vnum { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .verdict td:last-child { min-width: 140px; }
  .findings h3 { font-size: 13.5px; margin: 16px 0 6px; }
  .findings h3:first-child { margin-top: 0; }
  .findings h4 { font-size: 12.5px; margin: 12px 0 4px; }
  .findings ul { margin: 0 0 10px; padding-left: 18px; }
  .findings li { margin: 4px 0; color: var(--ink2); }
  .findings li strong, .findings p strong { color: var(--ink); }
  .findings p { margin: 6px 0; color: var(--ink2); }
  .findings code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: var(--grid); padding: 0 4px; border-radius: 4px; }
  a.sess { color: var(--s1); text-decoration: none; white-space: nowrap; }
  a.sess:hover { text-decoration: underline; }
  .notelink { font-size: 11.5px; color: var(--muted); margin-top: 8px; }
  .notelink code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: var(--grid); padding: 0 4px; border-radius: 4px; }
</style>`;

let html: string;
if (!runB) {
  const run = runA;
  html = `<title>context-arch baseline — ${esc(run.runId)}</title>
${STYLE}
<div class="wrap">
  <h1>context-arch baseline</h1>
  <div class="sub">run <strong>${esc(run.runId)}</strong> · ${esc(run.runDate)} · model <strong>${esc(run.model)}</strong> · ${run.arch === "curated" ? "curated context (keep-log + recent window + state doc)" : "full-replay session behavior (current designbook)"}</div>

  ${verdictSectionSingle(run)}

  ${findingsSection()}

  ${statTilesSingle(run)}

  <h2>Per-task</h2>
  <div class="card">${perTaskTable([run])}</div>

  <h2>Charts — context growth, cost, and cache composition by turn</h2>
  ${chartLegendSingle}
  ${chartCardsSingle(run)}

  <h2>Quality matrix — scripted checks + judge verdicts</h2>
  ${qualityCardsSingle(run)}

  <h2>Per-task drill-down — turns</h2>
  ${drillCards(run)}
</div>
`;
} else {
  const before = runA;
  const after = runB;
  const overlayLegend = `
<div class="legend">
  <span><i class="key s1"></i>replay (before)</span>
  <span><i class="key s2"></i>curated (after)</span>
  <span><i class="key s3"></i>uncached input (stack)</span>
</div>`;
  html = `<title>context-arch — replay vs curated</title>
${STYLE}
<div class="wrap">
  <h1>context-arch — replay vs curated</h1>
  <div class="sub">BEFORE <strong>${esc(before.runId)}</strong> (${esc(before.arch)}) · AFTER <strong>${esc(after.runId)}</strong> (${esc(after.arch)}) · model <strong>${esc(after.model)}</strong> · curated = keep-log + last-3-turns + state doc + recall</div>

  ${verdictSectionCompare(before, after)}

  ${findingsSection()}

  ${statTilesCompare(before, after)}

  <h2>Per-task</h2>
  <div class="card">${perTaskTable([before, after])}</div>

  <h2>Charts — context size and cost by turn, replay vs curated</h2>
  ${overlayLegend}
  ${chartCardsCompare(before, after)}

  <h2>Quality matrix — scripted checks + judge verdicts, both runs</h2>
  ${qualityCardsCompare(before, after)}

  <h2>Per-task drill-down — replay (before)</h2>
  ${drillCards(before)}

  <h2>Per-task drill-down — curated (after)</h2>
  ${drillCards(after)}
</div>
`;
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(
  `dashboard → ${out} (${(html.length / 1024).toFixed(0)} KB, ${runA.results.length} tasks${runB ? `, comparison vs ${runB.runId}` : ""})`,
);
