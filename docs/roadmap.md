# Roadmap — from today's local tool to the hosted launch

_2026-07-05. Companion to [monetization.md](./monetization.md) + [marketing.md](./marketing.md). Phases ordered by dependency; sizes are relative (S/M/L/XL)._

## Where we are (built, local)
Workbench: infinite canvas, drill-in selection, component registry, code panel (real source, editable), Pi chat w/ canvas context. Adapters: theme (tokens, variants, modes), i18next (text tool, plurals/placeholders, per-locale writes), flags (per-tenant). Figma: plugin WS bridge, token↔variable sync, component render push (autolayout/text-sizing/slots/instances), delta pull w/ sync cursor, delta→Pi handoff. Branch instances/worktrees local. Demo app.

## Phase 0 — Finish the local product (pre-OSS-launch) [M→L]
- [ ] **ARCHITECTURE PIVOT (decided 2026-07-06, pre-OSS): injected-workbench topology (Model C)** — C2 workbench-as-library → C3 designbookPlugin() + sidecar proxy + reload rehydration → C4 config-in-their-build. See docs/runtime-topology.md + docs/specs/c2-workbench-library.md. Spike S1 passed 6/6.
- [ ] Fix known bugs: first Push-to-Figma click no-op; any drill-in/text-tool rough edges
- [ ] Figma bridge auth (pairing proof — currently plain connect; AUTH-NOTES.md)
- [ ] `designbook init` CLI: interactive config scaffold for manual (dev) onboarding
- [ ] Adapter SDK hardening: stable public types, docs, example custom adapter
- [ ] 1–2 more adapters to prove generality (candidates from demand: react-intl, styled-tokens, Statsig/LaunchDarkly-style flags)
- [ ] Error/empty-state UX pass; onboarding docs; README + docs site
- [ ] Test/CI hardening (unit green in CI, plugin build artifact)

## Phase 1 — OSS launch [S]
- [ ] Polish demo repo as template; 90-sec demo video (full loop incl. Figma round-trip)
- [ ] Show HN + Storybook-comparison post; docs site live
- [ ] Telemetry (opt-in): activation events, adapter-gap detection groundwork

## Phase 2 — Hosted foundation [XL] ← the big build
- [ ] Control plane: orgs/users/projects, Postgres, auth (GitHub OAuth)
- [ ] GitHub App (read-only clone + PR write scope), repo connect flow
- [ ] Sandboxed build service: isolated per-repo builds (Firecracker/containers), private package secrets, monorepo/scoped-import support
- [ ] Instance orchestration: designbook server per book, scale-to-zero (hibernate idle, wake on visit), branch instance per PR
- [ ] **Browser-runtime spike** (cost lever): Sandpack/Nodebox vs WebContainers (⚠️ commercial license) vs server sandbox — hybrid target: Vite/render in visitor's browser, Pi agent + git server-side
- [ ] Share links: per-branch URLs, viewer auth (public/org/invite), read-only mode
- [ ] Hosted Pi: server-side agent sessions, per-org credit metering plumbing

## Phase 3 — Self-onboarding agent [L]
- [ ] Repo analysis agent: detect framework, components, tokens, i18n, flags → generate config
- [ ] Render-verify loop (config is only shown if the book boots); guided-picker fallback
- [ ] Config PR loop (agent opens PR; dev merge = dev-side onboard)
- [ ] Repo dedupe (second connector joins existing book)
- [ ] Adapter-gap detection → feature-request capture (+ paid-preference voting later)

## Phase 4 — Collaboration + review [L]
- [ ] Comments (canvas-anchored), presence/multiplayer cursors
- [ ] Review flow: proposed-changes queue, approvals, PR status integration
- [ ] Notifications (Slack/email)

## Phase 5 — Billing + plans [M]
- [ ] Stripe: subscriptions (Free/Pro/Team/Enterprise), prepaid credit packs (all tiers)
- [ ] Credit metering: dollar-equivalent ledger, daily drip + monthly cap on free, pooled team credits
- [ ] Entitlements: instance limits, seat roles (editor vs free dev/viewer)
- [ ] Model routing for margin: small models for mechanical edits (token writes, i18n, delta application)

## Phase 6 — Background agents [L]
- [ ] Scheduler + standing agent definitions (cron-ish, event-driven)
- [ ] Integrations v1: Amplitude (funnel watcher) + design-system hygiene sweeps (drift, unused tokens, a11y, i18n gaps)
- [ ] Suggestion queue → review → apply-via-Pi loop; run-credit billing
- [ ] Cloud parallel branch instances ("background branches")

## Phase 7 — Enterprise/governance [L]
- [ ] SSO/SAML, SCIM, RBAC, audit log
- [ ] Token drift reports, sync history, edit policies (who may edit which tokens/components/flags)
- [ ] Self-host/VPC distribution; SOC2 program

## Sequencing logic
0→1 builds the wedge + credibility before spending on infra. 2 is the long pole — start the browser-runtime spike early since it changes 2's architecture. 3 rides on 2 (needs sandbox builds). 4–5 make the money loop (share → collaborate → pay). 6–7 are expansion/enterprise, in demand order.

## Deliberately not now
Engineer config surfaces (data models/contracts — north star, post-designer-motion), visual regression CI, adapter marketplace, third-party adapter SDK program.
