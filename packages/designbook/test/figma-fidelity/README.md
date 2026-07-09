# Figma sync fidelity harness — run ritual

Semi-automated check of what **real Figma** does with designbook's pushed node
specs (font rasterization, autolayout resolution, absolute positioning, token
binding), then asserts the declarative pull loses nothing. This is the scripted
replacement for the manual "Real-Figma e2e" pass. Design + rationale:
`docs/specs/figma-sync-testing.md`.

It is **not CI**: it needs Figma desktop open with the designbook plugin
attached (no headless Figma exists). The pure logic (case config, HTML
normalize/compare, report, CLI) is unit tested under `pnpm test:run`; this
harness is the periodic live-engine check.

## One-time setup

1. Build the package (the harness spawns the built CLI + plugin):
   ```
   pnpm --filter '@designbookapp/designbook' build
   ```
2. Install Google Chrome (the runner drives it via `playwright-core`, which
   ships **no** bundled browser). Override with `DESIGNBOOK_FIDELITY_CHROME_PATH`
   (explicit binary) or `DESIGNBOOK_FIDELITY_CHROME_CHANNEL` (default `chrome`).
3. In Figma desktop, use a **dedicated test file / page** (decision 8 — exports
   overwrite the same page's frames each run; don't point it at real design
   work). Not enforced programmatically.

## Each run

1. **Stop every other designbook instance** (dogfood, demo, app). The plugin
   probes ports `8787→8797` and attaches to the **first** it finds; the harness
   uses **8791** (decision 2), so a lower-port instance would steal the plugin.
2. Open the Figma test file → run the **designbook** plugin → confirm it says
   connected. The plugin will attach to the harness sidecar once it starts.
3. First run only, per token case: in the workbench Theme tab, **Sync to
   Figma** once so the `designbook/theme` variables exist (else `token-colors`
   pulls back without `data-token-*`).
4. Run it:
   ```
   pnpm --filter '@designbookapp/designbook' test:figma
   ```
   The runner spawns the sidecar on 8791, preflights the plugin connection
   (clear error + exit if not connected), then per case: renders it headless,
   clicks the real **Push to Figma** button, exports the Figma PNG, pulls the
   annotated HTML, and compares.

## First-run approval (decision 5)

Cases ship **without** `expected.html`. The first run reports each as **NEW**
and writes `results/<timestamp>/<case>/pulled.html`. Review the pulled HTML +
the browser/figma PNGs in the report, then promote the good ones:

```
pnpm --filter '@designbookapp/designbook' test:figma --approve all
# or a subset:
pnpm --filter '@designbookapp/designbook' test:figma --approve solid-bg,token-colors
```

`--approve` copies that run's `pulled.html` to the committed
`cases/<id>/expected.html`. Commit those. Subsequent runs gate on tier-1
(HTML) equality against them.

## Reading the report

`results/<timestamp>/index.html` (self-contained): one row per case — browser
PNG · Figma PNG · diff/pixel · tier-1 verdict · tier-3 vision · push warnings.
Only the **tier-1** column gates the exit code (0 = all HTML-equal, 1 = a
mismatch or error). Clean all-pass runs prune their results dir; NEW/failed
runs are kept so you can approve or debug.

## Flags

| Flag | Effect |
|---|---|
| `--case <id>` | Run only these cases (repeatable / comma-separated). |
| `--approve <id\|all>` | Promote pulled → `expected.html` after review. |
| `--vision [all]` | Tier-3 agent vision compare (P3; flagged cases, or `all`). |
| `--port <n>` | Sidecar port (default 8791; keep it in 8787–8797). |
| `--keep-results` | Keep the results dir even on a clean pass. |

## Layout

```
test/figma-fidelity/
  fidelity.config.tsx     designbook config: the `fidelity` set + theme tokens
  theme.css               token source for the themeAdapter
  caseConfig.ts           the case matrix + id→route derivations (unit tested)
  normalize.ts            tier-1 HTML parse/normalize/compare (unit tested)
  report.ts               self-contained HTML report (unit tested)
  cli.ts                  arg parsing (unit tested)
  run.ts                  the runner (spawn→preflight→playwright→compare)
  cases/<id>/Case.tsx     the component
  cases/<id>/expected.html   approved pull snapshot (committed after --approve)
  results/                gitignored run artifacts
```
