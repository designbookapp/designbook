# Context-architecture baseline — full-replay (current behavior)

Baseline measurement of designbook's CURRENT pi session behavior (full message
history replayed on every LLM call, with provider prompt caching). The planned
keep-log + last-3-turns + state-doc + grep-recall architecture must beat these
numbers.

- **Run**: `runs/2026-07-11T05-52-44-387Z` (raw per-call request payloads +
  per-call metrics live there; gitignored but persists in the main tree —
  regenerate with one command below). A rendered snapshot of this run is
  committed at `report/dashboard.html`.
- **Date**: 2026-07-11 · **Model**: `claude-opus-4-8`, thinking `medium`,
  PINNED explicitly (anthropic/claude-opus-4-8 via pi's ModelRegistry) — the
  machine's pi default has drifted to another provider, so the runner never
  trusts `~/.pi/agent/settings.json`.
- **SDK**: `@earendil-works/pi-coding-agent` 0.80.6, driven headlessly via
  `createAgentSession` with the same construction as designbook's `/api` chat
  (cwd-scoped Settings/SessionManager, DefaultResourceLoader + packaged
  `variations` skill, project untrusted). No server, no browser.
- **Tasks**: 8 synthesized multi-turn tasks (61 user turns total) mirroring
  real session shapes found in `~/.pi/agent/sessions` (canvas-node-context
  prompts, 1–5 tool calls per turn, read/edit/bash on `examples/demo` files).
  Tasks 01–06 are SHORT (4–5 turns); tasks 07–08 are LONG (18 and 17 turns)
  built to surface forgetting: an early standing constraint that later turns
  silently depend on, a decision amended mid-stream, a mid-session
  "why did we decide X?" probe, re-visit turns where re-reading an unchanged
  file counts against `max_reads`, and a final from-memory recap graded
  against early facts.
- **Workspace**: fresh temp copy of `examples/demo` per task (AGENTS.md anchor
  + neutral skills copy — the workspace-escape fix — verified active).
- **Spend**: **$1.504** total (cap was $8; judge calls excluded, ~$0.08 more).
- **Judge**: opus-4-8, max_tokens **1500** (raised from 500 after a long-task
  truncation in the previous run — all 8 judge replies parsed cleanly this
  run), now also grades `unrequested_edits` (scope creep).

## How to run

```sh
pnpm --dir evals/context-arch run baseline          # real provider (keys from ~/.pi/agent/auth.json), pinned claude-opus-4-8
pnpm --dir evals/context-arch run dry-run           # mock provider on :8815, no keys/spend
node evals/context-arch/src/run.ts --task <id> --cap <usd>   # single task / custom cap
node evals/context-arch/src/report.ts evals/context-arch/runs/<run-id>   # render these tables
pnpm --dir evals/context-arch run dashboard         # regenerate report/dashboard.html from the latest run
```

Artifacts per run: `runs/<run-id>/<task>/payloads.jsonl` (FULL raw provider
request payload per LLM call — diff these against the new architecture),
`results.json` (per-call usage/latency/context size, per-turn results, check
+ judge outcomes), `summary.json`. The pi session JSONL archive (input for
grep-recall) is written to `~/.pi/agent/sessions/<workspace-slug>/` as usual;
each `results.json` records the exact path.

## Per-task

| task | turns | LLM calls | input (uncached) | cache read | cache write | output | cost | wall | checks | judge |
|---|---|---|---|---|---|---|---|---|---|---|
| 01-card-footer-iteration | 5 | 13 | 26 | 51,647 | 5,305 | 1,150 | $0.088 | 32s | 6/6 | redid:n contra:n creep:n |
| 02-badge-button-variants | 5 | 12 | 24 | 51,940 | 4,763 | 1,148 | $0.085 | 30s | 8/8 | redid:n contra:n creep:n |
| 03-locale-tagline | 4 | 11 | 22 | 43,324 | 3,865 | 1,181 | $0.075 | 37s | 5/5 | redid:n contra:n creep:n |
| 04-product-card-constraint | 4 | 11 | 22 | 76,381 | 8,779 | 3,947 | $0.192 | 79s | 4/4 | redid:n contra:n creep:n |
| 05-nav-stories-link | 4 | 13 | 26 | 63,453 | 5,476 | 1,693 | $0.108 | 39s | 7/7 | redid:n contra:n creep:n |
| 06-session-recap | 4 | 8 | 16 | 40,023 | 5,544 | 1,536 | $0.093 | 35s | 8/8 | redid:n contra:n creep:n |
| 07-accent-rollout | 18 | 44 | 88 | 432,433 | 14,925 | 6,513 | $0.473 | 132s | 32/32 | redid:n contra:n creep:n |
| 08-journeys-copy-refresh | 17 | 39 | 78 | 336,503 | 11,754 | 5,932 | $0.390 | 129s | 27/27 | redid:n contra:n creep:n |

judge = LLM judge (opus-4-8) on the task rubric: `redid` = redid work already
done, `contra` = contradicted an earlier decision, `creep` = unrequested
edits (scope creep — new category this run).

## Aggregate

- 8 tasks, 61 user turns, **151 LLM calls (2.5 calls/turn)**
- tokens: input (uncached) **302**, cacheRead **1,095,704**, cacheWrite
  **60,411**, output **23,100**
- **cached share of prompt tokens: 94.7%** (uncached input is ~2 tokens/call —
  pi's cache breakpoints catch essentially the whole prefix)
- cost **$1.504** ($0.188/task, **$0.025/turn**), wall 8.5 min
- prompt tokens per turn (in+cacheRead+cacheWrite): **18,958 avg**
- per-call latency (time to provider response headers): p50 1.7s, p90 2.2s,
  max 14.0s. Turn wall-clock (incl. tool exec + streaming): typically 5–15s.

## Short vs long (the review question)

| slice | tasks | turns | calls | cache read | cache write | output | cost | cost/turn | prompt tok/turn | context @ final turn | checks |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SHORT (01–06) | 6 | 26 | 68 | 326,768 | 33,732 | 10,655 | $0.641 | $0.0247 | 13,871 | 5.1–10.0K | 38/38 |
| LONG (07–08) | 2 | 35 | 83 | 768,936 | 26,679 | 12,445 | $0.863 | $0.0247 | 22,737 | 13.0–16.1K | 59/59 |

Wall: SHORT 251s (9.7s/turn, p50 latency 1.8s) · LONG 261s (7.5s/turn, p50
latency 1.7s) — no latency penalty at ~4× session length.

- **Quality checks did NOT start failing.** 59/59 scripted checks on the long
  tasks — every forgetting probe passed: the turn-3 amendment (teal-600 →
  teal-700) was applied from memory at turns 5, 6, and 15 ("use the shade we
  settled on") and correctly attributed to AA contrast at the turn-9 probe;
  the turn-1 atoms.tsx ban held throughout and was named correctly at the
  probe; original copy was quoted from memory in the recap; the
  silently-binding copy rules (journeys, no exclamation marks) were applied
  unprompted at turns 12–13; both final recaps listed exactly the modified
  files. `max_reads` discipline held (1–2 reads/file across 17–18 turns).
  LLM judge: no redid-work, no contradicted-decision, no unrequested edits
  on either long task.
- **Cost/turn is FLAT ($0.0247 in BOTH slices)** even though prompt
  tokens/turn grows ~1.6× (13.9K → 22.7K). Two reasons: the growing base is
  billed as cache reads (0.1×), and cache writes amortize — the long tasks
  wrote LESS cache total (26.7K) than the six short ones (33.7K).
  Full-replay's cost curve at this length is dominated by output tokens, not
  context size.
- **Context grows linearly, ~500–680 prompt tokens per turn** (07: 4.5K →
  16.1K over 18 turns; 08: 4.8K → 13.0K over 17). Extrapolating to the 40+
  turn / bigger-file sessions seen in real sandbox use (~30–60K-token
  prompts), the read base alone starts to cost ~$0.02–0.06 per LLM call in
  cache reads — that, plus latency and the context-window ceiling, remains
  the regime the new architecture targets; quality at ≤18 turns is NOT the
  baseline's weakness.

## Context growth by turn (the thing the new architecture attacks)

Request payload sent to the provider at the LAST call of each user turn
(abbreviated to first/last + long-task milestones — full table via
`node src/report.ts`):

| task | turn | calls in turn | msgs in payload | payload KB | prompt tokens |
|---|---|---|---|---|---|
| 01-card-footer-iteration | 1 | 4 | 7 | 11 | 4,012 |
| 01-card-footer-iteration | 5 | 3 | 25 | 15 | 5,307 |
| 02-badge-button-variants | 1 | 4 | 7 | 11 | 4,282 |
| 02-badge-button-variants | 5 | 1 | 23 | 17 | 5,959 |
| 03-locale-tagline | 1 | 3 | 5 | 10 | 3,775 |
| 03-locale-tagline | 4 | 1 | 21 | 14 | 5,061 |
| 04-product-card-constraint | 1 | 4 | 7 | 24 | 7,661 |
| 04-product-card-constraint | 4 | 1 | 21 | 32 | 9,975 |
| 05-nav-stories-link | 1 | 4 | 7 | 13 | 4,805 |
| 05-nav-stories-link | 4 | 1 | 25 | 18 | 6,672 |
| 06-session-recap | 1 | 3 | 5 | 15 | 5,408 |
| 06-session-recap | 4 | 1 | 15 | 19 | 6,740 |
| 07-accent-rollout | 1 | 4 | 7 | 12 | 4,544 |
| 07-accent-rollout | 4 | 3 | 23 | 20 | 7,268 |
| 07-accent-rollout | 8 | 4 | 49 | 32 | 11,660 |
| 07-accent-rollout | 12 | 1 | 65 | 37 | 12,905 |
| 07-accent-rollout | 15 | 3 | 81 | 44 | 15,275 |
| 07-accent-rollout | 18 | 1 | 87 | 47 | 16,121 |
| 08-journeys-copy-refresh | 1 | 2 | 3 | 13 | 4,776 |
| 08-journeys-copy-refresh | 4 | 3 | 21 | 20 | 6,946 |
| 08-journeys-copy-refresh | 8 | 2 | 37 | 25 | 8,411 |
| 08-journeys-copy-refresh | 12 | 3 | 61 | 35 | 11,855 |
| 08-journeys-copy-refresh | 15 | 1 | 73 | 37 | 12,762 |
| 08-journeys-copy-refresh | 17 | 1 | 77 | 38 | 12,950 |

Fixed floor: system prompt ≈ 5.2KB + 4 tool schemas ≈ 3KB → every call starts
around 8.5KB / ~2.5–3K tokens before any conversation.

## Quality (baseline behaves WELL even at 17–18 turns)

- Scripted checks: **97/97 pass** across all tasks — including every
  forgetting, decision-retention, constraint-retention, silent-dependency and
  recap probe in the long tasks (see the short-vs-long section above for the
  itemized long-task probes).
- LLM judge: no redid-work, no contradicted-decision, and no unrequested
  edits on any of the 8 tasks.
- Re-read discipline: all `max_reads` checks pass. The agent edits files it
  touched many turns ago from memory without re-reading.
- The previous run's one behavioral wrinkle (an unrequested — but honestly
  recapped — CTA variant switch in task 07) is now a first-class judge
  category (`unrequested_edits`); this run the judge flagged NONE, so it was
  a one-off, not a systematic behavior.

At ≤18 user turns the full-replay baseline has effectively no forgetting —
the new architecture's win at THESE lengths must come from tokens/cost/latency
(and from the >18-turn / large-read regime), not from quality at this scale.

## Surprises / notes

1. **Cache economics dominate even harder at length.** Cached share is 90.6%
   on the short slice vs 96.6% on the long one — long sessions amortize cache
   writes across more reads. Uncached input stays ~2 tokens/call. Cost split
   of this run: reads ~$0.55, writes ~$0.38, output ~$0.58 — a leaner context
   wins primarily by shrinking the growing read base and the per-turn floor;
   naive "fewer prompt tokens" comparisons priced at full input rate
   overstate savings ~10×.
2. **Growth is linear and modest at this scale** (~500–680 prompt tokens per
   additional turn on the long tasks; a big file rewrite bumps it — task 04
   hit 10K in 4 turns). Real 40+ turn sandbox sessions extrapolate to
   30–60K-token prompts per call — the head-to-head regime for the new
   architecture.
3. **Absolute paths in the system prompt steer the agent hard.** The
   first-ever run escaped the temp workspace via pi's skill `<location>` +
   docs paths. Fixed by copying skills to a neutral dir + an `AGENTS.md` root
   anchor in the fixture; fix verified active for this run (post-run
   `git status` clean outside `evals/context-arch/`). Path anchoring is
   load-bearing for whatever goes in the keep-log/state doc.
4. **The machine's pi default model changed between runs** (now another
   provider's model) — the runner pins anthropic/claude-opus-4-8 explicitly.
   Any future comparison run MUST keep the pin.
5. **Latency numbers are time-to-response-headers** (captured at
   `after_provider_response`, before the stream is consumed). Use turn
   wall-clock for end-to-end feel.
6. `session.prompt()` resolves even on provider errors — the harness detects
   them from the transcript (`stopReason === "error"`) and aborts the task
   script. None occurred in this run.
7. **Judge truncation fixed.** The previous run's judge overflowed its
   500-token cap on task 07 (reply truncated mid-JSON, fell back to
   defaults). Cap raised to 1500; all 8 judge replies parsed cleanly this
   run.
8. **Run-to-run stability is good**: totals within ~1% of the previous
   baseline ($1.504 vs $1.513, 151 vs 150 calls, identical check results) —
   the suite is a usable regression bar.

## Production-parity gaps (accepted for the baseline)

- Integration custom tools (figma etc.) are not registered — that would need
  designbook's full integration registry. Tool list here is the 4 pi
  built-ins; production designbook sessions add a handful of schemas (bigger
  fixed floor, same growth shape).
- Only the main-chat session type is exercised; variations/sandbox ephemeral
  sessions (restricted tools, single-turn) are not — they're less relevant to
  the context-arch experiment since they don't accumulate history.
- One fixture (examples/demo). Real repos are bigger, so file reads (the main
  history payload) are proportionally larger.

## Dashboard

`report/dashboard.html` is a fully self-contained (no fetch/CDN, strict-CSP
safe, light+dark) visual snapshot of the committed run. It now leads with a
**Verdict** section — a 3×3 short-vs-long comparison (cost, time, quality)
that answers the review question at a glance — followed by a **Findings &
recommendations** block rendered at generation time from
`report/findings.md` (edit that file and re-run the dashboard command to
update the block). Below those: stat tiles, per-task table, per-task
context-growth/cost/cache-composition charts, the full quality matrix with
expandable failure detail, and per-turn drill-downs. Regenerate from any run
dir:

```sh
pnpm --dir evals/context-arch run dashboard                    # latest run
node evals/context-arch/src/dashboard.ts runs/<run-id>         # specific run
```

## designbook source changes made

**None to `packages/designbook` source.** Only repo-level config:
`pnpm-workspace.yaml` gained `evals/*` so the harness resolves the pinned pi
SDK through the workspace. Everything else lives under `evals/context-arch/`.

## Suggested next step

Build the new context assembler behind the same `createAgentSession` seam and
re-run this suite unchanged (payload JSONLs diff directly). Quality parity at
≤18 turns is now a REGRESSION BAR for the new architecture (97/97), while the
efficiency win must show up in cacheWrite + read-base growth and in the
per-turn token floor. To make quality deltas measurable, the next task-set
extension should push past this regime: 30–40 turn sessions and/or large-file
reads (the mono-app fixture), where replay + summarize-away is expected to
start dropping early constraints.
