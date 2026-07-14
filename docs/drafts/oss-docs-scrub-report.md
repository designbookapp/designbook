# OSS docs scrub report

Generated as part of the OSS-launch sweep (see `docs/oss-launch.md`). This is
a **review artifact only** — no doc content was cut or rephrased. Each hit is
`file:line — quoted snippet — recommended action`. Apply cuts is a judgment
call left to Michael.

Scope scanned: `docs/`, `docs-site/src/content/docs/`, `README.md`,
`marketing/`.

## Summary

- **~35 "Refract" brand leftovers** — all in `marketing/` (concept sites +
  video plan) and `docs/marketing.md` / `docs/monetization.md`. Zero in
  `docs-site/` (the real public docs site) or `README.md` — those are already
  clean and on-brand as `designbook`.
- **~15 coming-soon / roadmap-promise hits** — concentrated in
  `docs/roadmap.md`, `docs/monetization.md`, `marketing/index.html`,
  `marketing/b/index.html`. `docs-site/` has only 2-3 soft, honest
  limitation notes (not vaporware promises) — see below.
- **~10 internal-process references** ("Michael", "spike", "worktree agent",
  milestone codes M1-M3/P1-P4/C2-C4/R/S1-S2, "decided with Michael, do not
  re-litigate") — entirely inside `docs/specs/`, `docs/spikes/`,
  `docs/drafts/`, `docs/runtime-topology.md`, `docs/roadmap.md`,
  `docs/superpowers/`. None in `docs-site/`.
- **Recommendation on `docs/specs/`, `docs/spikes/`, `docs/drafts/`,
  `docs/superpowers/`, `docs/roadmap.md`, `docs/monetization.md`,
  `docs/marketing.md`, `docs/marketing-b.md`, `marketing/`**: these should
  **NOT ship in the public repo** at all. They're internal design-process /
  business-strategy artifacts (decision logs "with Michael", pricing
  strategy, naming brainstorms including a since-rejected "Refract" brand,
  spike writeups). Recommend excluding the whole set from the squashed public
  history (keep them in the private repo, or move to a separate internal
  docs location) rather than doc-by-doc redaction. `docs/oss-launch.md`
  itself is also internal (references this very sweep) and should not ship.
- **`docs-site/` (the actual public docs) is close to launch-ready as-is** —
  only the Figma page's "spike" framing needs a rephrase; nothing else found.

## Hits

### (a) Coming-soon / roadmap / vaporware promises

| File:Line | Snippet | Action |
|---|---|---|
| `docs/marketing.md:30` | "**Coming soon tease**: background agents (funnel-watching PM agent) + configuration-first future" | Internal — doc excluded from public repo (see recommendation above) |
| `docs/monetization.md:76` | "eventually third-party adapter ecosystem" | Internal — doc excluded |
| `docs/monetization.md:86` | "SOC2 eventually" | Internal — doc excluded |
| `docs/adapters-setup.md:164` | "runtime mirroring provider-set attributes onto cell containers automatically is on the backlog; until then, `FlagScope` is the pattern" | This file DOES ship publicly (referenced from README/docs-site adapter guide). Rephrase to drop "on the backlog" — state `FlagScope` as the current pattern without promising a future runtime feature, or cut the sentence fragment about the backlog |
| `marketing/index.html:1127-1146` | "COMING SOON" section, two `.soon-tag` chips | Concept marketing site, not shipped with repo/docs-site — no action needed unless this file is later repurposed as the real public marketing site, in which case cut or replace with real features |
| `marketing/b/index.html:994,1003` | Two `<span class="soon">Coming soon</span>` | Same as above — concept site B, not shipped |
| `docs/roadmap.md` (whole file) | Phase 0-7 roadmap incl. unbuilt hosted product, control plane, browser-runtime spike | Internal strategy doc — excluded from public repo |
| `docs-site/src/content/docs/adapters/custom.md:9` | "the SDK for authoring your own is not yet frozen and may [change]" | Public, honest caveat — keep, optionally soften wording slightly but not vaporware |
| `docs-site/src/content/docs/repo/nextjs.md:37` | "not yet available" (Next.js support) | Public, honest limitation statement — keep as-is |

### (b) Internal-process references

| File:Line | Snippet | Action |
|---|---|---|
| `docs/specs/p-flow-iframes.md:5` | "Michael's \"App page\" entry point" | Doc excluded from public repo (internal spec) |
| `docs/specs/c4-config-codegen.md:14` | "**Host context** (Michael's Q&A)" | Doc excluded |
| `docs/monetization.md:93` | "**Michael's feedback:**" | Doc excluded |
| `docs/specs/c3-designbook-plugin.md:9` | "Design decisions (settled with Michael, do not re-litigate)" | Doc excluded |
| `docs/specs/r-ui-reorg.md:3,47` | "Decided with Michael 2026-07-07…", "(Michael 2026-07-07)" | Doc excluded |
| `docs/drafts/pi-agent-instructions.md:138,180` | "…which one Michael wants", "what Michael originally [wanted]" | Already under `docs/drafts/` — excluded by convention |
| `docs/specs/m-page-tools.md:3` | "Decided with Michael 2026-07-06" | Doc excluded |
| `docs/runtime-topology.md` (whole file) | "spike evidence in spikes/s1…", compat-tax/4-repo-spike references | Internal decision record — excluded |
| Git-log-adjacent process language ("worktree agent" merge commits) | N/A — not in doc *content*, but D4 (squash history) already handles this; flagging so the squash isn't skipped | No doc action; confirm D4 (squash) executes before going public |
| `docs/superpowers/specs/2026-07-03-designbook-design.md:3,34` | "Migrated from the `design/` MVP…(from commerce-portals)" | Doc excluded — references a private sibling monorepo by name |

### (c) Reads as not-yet-real / needs rephrase for public tone

| File:Line | Snippet | Action |
|---|---|---|
| `docs-site/src/content/docs/figma.md:10-14,28` | "Protocol spike", "designbook sync (spike)", "treat it as a spike, not hardened" | This page DOES ship. Rephrase "spike" language to something public-appropriate, e.g. "early/experimental — local-only, no auth yet" — keep the honest limitation, drop the internal jargon word "spike" and the parenthetical plugin name if it's confusing for external users |
| `docs/compat-spike.md` (whole file) | 4-repo compat spike write-up, internal evidence log | Internal — excluded from public repo (or link from CONTRIBUTING as engineering-history context only, at Michael's discretion) |

### Refract brand leftovers (for completeness — not counted separately above since these files are recommended for exclusion wholesale)

`docs/marketing.md:3,35,38`, `docs/monetization.md:95,99,153`,
`marketing/index.html` (title, logo x2, hero copy, footer x2, concept note),
`marketing/b/index.html` (title, logo x3, lede, section copy x3, footer x2),
`marketing/videos/instruction-video-plan.md:1,169`,
`marketing/videos/README.md:3`. All inside files recommended for exclusion
or already flagged as a concept/working-name site. **Zero Refract mentions
in `docs-site/`, `README.md`, or `packages/designbook/`** — the shipped
product surface is already correctly branded `designbook`.

## Should `specs/`/`drafts/`/`spikes/`/`superpowers/` ship publicly?

**No, recommend excluding all four wholesale.** They're internal-by-nature
(per the task brief) and every file sampled confirms it: decision logs
addressed to "Michael", milestone shorthand (M1-M3, P1-P4, C2-C4, R, S1-S2)
meaningless to an outside reader, and business-strategy content
(`monetization.md`, `roadmap.md`) that shouldn't be public regardless of
process-reference cleanup. Recommend: keep `docs/specs/`, `docs/spikes/`,
`docs/drafts/`, `docs/superpowers/`, `docs/roadmap.md`,
`docs/monetization.md`, `docs/marketing.md`, `docs/marketing-b.md`,
`docs/compat-spike.md`, `docs/oss-launch.md`, and all of `marketing/` out of
the squashed public history entirely (D4 already plans a history squash —
this just means these paths shouldn't be in the tree at squash time, not
merely redacted). Public docs = `docs-site/`, `README.md`, `CHANGELOG.md`,
`LICENSE`, `docs/client-setup.md`, `docs/adapters-setup.md` (both need the
minor edits noted above), plus whatever `CONTRIBUTING.md` the user adds.
