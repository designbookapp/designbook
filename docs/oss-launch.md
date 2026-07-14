# OSS launch — decision record

_Decided by Michael 2026-07-07 (decision-sheet artifact). Sequencing: P3 →
UI re-org (R spec) → this sweep → launch. D6 (launch scope) intentionally
open until P3 testing._

| # | Decision | Choice |
|---|----------|--------|
| D1 | npm name | Publish bare `designbook` at launch (package name verified free 2026-07-08). npm org/user name `designbook` is squatted (no packages) — scope reserved as **`@designbookapp`** instead (created 2026-07-08, matches the GitHub org); future scoped packages ship as `@designbookapp/*` |
| D2 | License | MIT (LICENSE file to add) |
| D3 | Repo home | New GitHub org (name TBD — check availability), repo transferred there at launch |
| D4 | Git history | Squash to a fresh initial commit for the public repo; private repo keeps full history |
| D5 | Version | 0.3.0 |
| D6 | Launch scope | OPEN — post-P3; potentially P4/UX improvements depending on testing |
| D7 | Docs & community | Docs on Vercel at **docs.designbook.app** (domain designbook.app bought, on Vercel); GitHub issues only at launch |

## Sweep checklist (run after the re-org)

- [x] LICENSE file (MIT) + package.json metadata (repository/homepage/bugs;
      OWNER resolved to the `designbookapp` GitHub org)
- [x] **Docs content decision (Michael 2026-07-07): only `docs-site/` ships
      public.** Everything else stays internal (private repo only) rather than
      line-edited — exclude wholesale from the squashed public repo:
      `docs/specs`, `docs/spikes`, `docs/drafts`, `docs/superpowers`,
      `docs/roadmap.md`, `docs/monetization.md`, `docs/marketing*.md`,
      `docs/compat-spike.md`, `docs/runtime-topology.md`, `docs/oss-launch.md`,
      and all of `marketing/`. Scrub detail: `docs/drafts/oss-docs-scrub-report.md`.
      docs-site polish before publish: rephrase the figma page's "spike"
      framing (`docs-site/src/content/docs/figma.md`).
- [x] Public README + quickstart
- [ ] docs-site deploy to Vercel, docs.designbook.app subdomain
- [x] CI: build + typecheck + test on PR (GitHub Actions)
- [x] CHANGELOG (Unreleased); 0.3.0 version cut deferred to launch
- [ ] CONTRIBUTING.md, issue templates; repo settings (public, branch
      protection); Discussions OFF at launch
- [ ] Fresh-history public repo (squash, docs-site-only per above) under
      `designbookapp`; npm publish `@designbookapp/designbook@0.3.0` (`npm publish --access public` — scoped pkgs are private by default) with 2FA/provenance
- [ ] Pre-publish packaging smoke: `pnpm pack` + install in a fresh dir

## Owner actions (Michael — account-level, not automatable)

- [x] Create npm org — `designbook` squatted; **`designbookapp`** created instead (Michael 2026-07-08)
- [x] Create the GitHub org — `designbookapp` created 2026-07-07
- [x] Domain designbook.app (bought, Vercel)
