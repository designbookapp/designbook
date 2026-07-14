# designbook monetization — strategy notes

_Working doc from strategy session 2026-07-05. Living document; revisit as product/traction evolves._

## What we're selling into

designbook = OSS-feeling local tool, installs in the customer's repo like Storybook, designers edit real components (theme/tokens, i18n text, flags, Figma round-trip) with an embedded Pi agent. Key buyer dynamic that shapes everything:

- **Dev installs, designer consumes.** Unlike Cursor (self-install, self-expense), there's a hand-off gap — mitigated by the designer self-onboarding agent (below), which gives designers their own front door. Team billing still matters earlier than it did for Cursor.
- Buyer: design-engineering / eng leadership (pays to cut design-implementation churn); design leadership co-signs (pays for prod-fidelity access).

## Comparables

| | Model | Lesson for us |
|---|---|---|
| **Storybook → Chromatic** | OSS local tool free; paid cloud (hosted books, visual review, approvals) | Monetize the multiplayer layer you can't do locally. Never paywall local single-player — it's the adoption engine. |
| **Cursor** | Tool ~free; meter the agent. Hobby → Pro $20 → Pro+ $60 (3×) → Ultra $200 (~$400 credit) → Teams $40 → Enterprise | Single-player monetizes day one via usage, not feature gates. Tier ladder = discounted prepaid compute; margin from breakage + routing. Teams = Pro + governance at 2× price (near-zero COGS). |
| **Figma** | Free viewer seats, paid editor seats | Charge the value seat; free seats spread the product. For us: designers/PMs = value seats, dev seats free/cheap (inverts Figma). |

### Cursor economics — what to copy, what to avoid

- **Bundles beat PAYG** via predictability (no bill shock, expensable flat fee) and face discount (Ultra $200 ≈ $400 credit). Margin survives on breakage — most subscribers don't burn the bundle.
- **Spread on frontier tokens is thin** (10–15% volume discount). Real margin = routing to own/cheap models + caching. Their own-model bet (Composer) is what turned gross margin barely positive at ~$4B ARR — they are still unprofitable overall, enterprise segment subsidizes loss-making individual tier (adverse selection: only heavy users pay $20).
- **Where Cursor loses money even on metered plans:** the unmetered baseline — keystroke autocomplete on own GPU fleet, codebase indexing/embeddings, prompt scaffolding/retries, legacy unlimited plans, free tier. The meter covers marginal tokens; the sub must also cover fixed fleet + unmetered features.
- **Our structural advantage:** designbook has no always-on keystroke model — the *local* product's unmetered baseline (canvas rendering, Figma sync, token probes) is ~free. Cloud COGS does exist (sandbox builds, always-on hosted instances, free onboarding inference, free-tier credit drip) but every line is **visible and per-account attributable** — priceable via the base fee or cappable via drips/limits. Contrast Cursor: per-keystroke costs they can neither meter nor decline. Better unit economics by construction, not by hope.
- **Pricing hygiene:** price in transparent dollar-equivalent credits from day one. Never invent an opaque unit ("requests") you'll have to walk back — Cursor's June-2025 repricing backlash is the cautionary tale.
- COGS reality check: AI-native tools run 30–60% gross margin vs SaaS's 75–85%. Plan margin from breakage, caching/routing, and cheap models for mechanical work — not from marking up tokens. Route constrained edits (token writes, i18n updates, Figma-delta application) to small models.

## Monetization options (ranked by fit)

### 1. Open-core + hosted cloud — strongest
Local single-player free forever. Charge for what literally can't run locally:
- **Hosted designbooks**: share links per branch/PR — no repo checkout. THE unlock for designers/PMs who'll never run `pnpm demo`.
- **Review workflow**: comments, approvals, "design changes requested" on PRs; Figma-style real-time collaboration/multiplayer on the canvas.
- **Background agentic workflows** (differentiator vs Chromatic — see below).
- Versioned design-system portal for stakeholders.

### 2. AI metering — second axis
- Free: daily credit drip w/ monthly cap (see onboarding) + BYOK escape hatch for power users.
- **Prepaid credit packs on EVERY tier incl. free** ($10/$25 top-ups, margin on all): removes BYOK friction — designers will never create an Anthropic account, so bundled inference is the only path most of the audience can take, not just margin. Prepaid (not metered-in-arrears) avoids bill-shock backlash + earns breakage on unused packs.
- Paid: managed inference w/ margin, dollar-credit bundles per seat, pooled team credits, usage multiplier tiers for agent-heavy designers.
- Premium agent jobs: multi-step design tasks, batch Figma-delta applies, "redesign this component".

### 3. Design-system governance — enterprise wedge
Uniquely positioned: we see tokens, components, Figma, AND code.
- Token drift reports (Figma ↔ code divergence, who changed what), sync history/audit for the bridge.
- Policy: which tokens/components designers may edit; per-tenant flag guardrails.
- Component adoption analytics. This is the 5–6-figure-contract layer.

### 4. Visual review/regression CI (later)
Chromatic's actual cash cow: per-PR snapshots, visual diffs, approval gates. We already render everything; heavy infra — later-stage.

### 5. Enterprise table stakes
SSO/SAML, RBAC, audit logs, self-host/VPC deploy, SCIM, SLA. Not a strategy; where contract size comes from.

**Weak options:** template/component marketplace (chicken-egg), paid Figma plugin (kills acquisition), paywalling the local tool (kills the wedge).

## New ideas (2026-07-05)

### Background agentic workflows (hosted) — strong, differentiating
Standing agents that run in the cloud against your designbook + connected systems, producing reviewable suggestions:
- PM sets an agent to watch Amplitude funnels → agent proposes UX/copy/flow edits as designbook change requests → PM reviews, one-click sends to Pi to apply.
- Periodic design-system hygiene agents (drift, unused tokens, a11y sweeps, i18n gaps).
- Works while laptop closed → genuinely requires hosting → honest paywall. This is the "Chromatic + Cursor background agents" fusion neither has; likely the demo that sells the cloud tier.

### Worktree/branch-instance gating — flagged, needs care
Idea: local = single-branch swap only; hosted = parallel background branches.
Assessment: **gate the compute, not the code.** Open-core rule of thumb — paywalling a feature that runs fine on the user's machine (worktrees are just git) breeds resentment and forks; it's gating what costs us nothing. The version of this that IS honest and gate-able: **parallel branches running in the cloud** — always-on branch instances with preview URLs, agents working multiple branches concurrently while the laptop is closed. Same designer benefit ("work multiple tasks at once") without hobbling the local tool. Recommend: keep local worktrees, sell "background branches" as a cloud capability.

### North star: configuration-first development (2026-07-05)
Future bet: engineers shift from editing code to agentic workflows — configuring bounded pieces of the repo (data models, API contracts, flags, permissions, analytics events, flows) while LLMs write the code. designbook's adapter mechanism is exactly this shape already: **typed control planes over the repo** — bounded surface → human edits structured artifact → agent reconciles code → code stays source of truth. Theme/i18n/flags proved the pattern with designers; the same environment scales to engineers.

Why it matters:
- **Surface-first vs chat-first.** Cursor/Devin/v0 = prose in, code out; trust/review is their bottleneck. Bounded surfaces make agent output constrained, diffable, reviewable by anyone. The boundaries are the product; the agent is plumbing.
- **Flips seat math**: engineer seats become value seats → TAM expands from design tooling to the dev-workflow market, differentiated from editor-owners.
- **New SKU shape**: adapters as products (data-model planner, contract designer, flag governance); eventually third-party adapter ecosystem.
- **Sequencing**: narrative ceiling, not v1 roadmap. Revenue path stays designer wedge → hosted share links → background agents; engineer surfaces come after the designer motion monetizes. Pitch the vision now — it's what makes this venture-scale rather than "Chromatic for themes."

### Designer self-onboarding via agent (2026-07-05)
Kill the "dev installs, designer consumes" gap: designer connects GitHub repo → agent reviews it and generates `designbook.config.tsx` → hosted book renders. Free LLM usage = **bounded per-repo CAC** (unlike Cursor's ongoing unmetered baseline): config generation runs once per repo (later connectors join the existing book), crisp conversion event (connect → render → invite).

- Agent detects framework/build, component exports, theme tokens, i18n layout, flags → emits config → **verifies by rendering before showing the user**; low confidence → guided picker fallback.
- **PR loop**: agent opens a PR adding the config → dev reviews/merges → dev side onboarded too. Each persona recruits the other.
- **Two front doors**: dev = `pnpm add @designbookapp/designbook` (local free); designer = "Connect GitHub" (cloud). Converge on the same hosted book. Implies hosted book = full running instance (settles open question 3).
- Large repos: scoped import (one package/design-system dir) for fast time-to-first-canvas; "import more" = in-product expansion loop.
- Real COGS = sandboxed builds of customer repos (private packages, env vars, monorepos), not tokens. Trust: read-only GitHub App, SOC2 eventually; repo-sensitivity pushes big cos to the self-host Enterprise SKU.
- **Not limited to once/org** (decision 2026-07-05): any user can onboard — cost per onboard is small. Dedupe by repo: second connector *joins the existing book* (cheaper + collaboration starts immediately). Free plan post-onboard: X credits/day drip, capped monthly (drip builds habit, cap bounds COGS).
- **Adapter-gap detection**: onboarding agent flags config systems we lack an adapter for → user can request as feature; paid users get roadmap preference (Canny-style voting). Side effect: onboarding telemetry = demand-ranked adapter roadmap (market research for free). Popular gaps → first-party adapters; long tail → future third-party adapter SDK.

### Naming note (2026-07-05)
"designbook" concerns: design-only (undersells the config-first engineer vision) + "-book" evokes Storybook = tool-nobody-pays-for association.

**Michael's feedback:**
- **No split brand** (OSS name ≠ cloud name rejected): Chromatic's anonymity relative to Storybook is a loss-leader failure — most users don't know they're connected. One brand across OSS + cloud.
- **Prism**: concept loved (one artifact refracted into bounded views) — blocked: OpenAI product owns Prism + prism.com redirect.
- **Trimtab**: story good ("okay for now"); trimtab.ai taken.

**Candidates in the Prism concept-space** (ranked by product-conflict cleanliness; all bare .coms are parked-not-productized → buy-side negotiations $3k–50k; real filter = active conflicts + ™ class 9/42):
- **Refract** — the verb of Prism; code bent into editable views. No major dev conflict.
- **Beamline** — physics: instrument stations tapping one light source = adapters on the repo. Distinctive, no prominent conflict.
- **Facet** — truest concept fit; facet.com = fintech (different ™ class, likely clearable).
- **Loupe** — jeweler's lens over facets; minor .NET logging tool conflict.
- **Pantograph** — trace the drawing, the linkage reproduces it = edit surface, code follows. Trimtab-grade story, cleaner availability.
- **Jig** — workshop tool constraining the cut = the boundaries story exactly; 3-letter domain brutal.
- **Oriel / Lightwell** — architectural windows into a structure; quiet, clean.
- Earlier round still live: **Patchbay**, **Redline**, **Vellum**.
- ⚠️ avoid: Prism/Prisma/Prismatic/Prismic (OpenAI/ORM/integration/CMS), Schematic (flags startup), Helm, Loom, Warp, Manifold, Chroma.
- Coined-word route (Figma/Vercel path) open if ™-clean + buyable domain outweighs dictionary-word warmth.

## Proposed tier model

| Tier | Price (draft) | Contents |
|---|---|---|
| **Free** | $0 | Full local tool (worktrees, Figma sync, BYOK) **and hosted starter** — self-onboarded book, scale-to-zero instance (hibernates on idle, wakes on visit), scoped import, daily credit drip (monthly cap). Prepaid credit packs purchasable. |
| **Pro** | ~$25/designer/mo | ~$15 included dollar-credits + software base fee, managed inference, priority models |
| **Team** | ~$40–50/editor/mo | Hosted branch books + share links, comments/review, real-time collab, background agents (metered), pooled credits, analytics; dev seats free/cheap |
| **Enterprise** | Custom | Governance/drift/audit, SSO/SCIM, self-host/VPC, pooled usage, SLA |

**Base fee > credits (decision 2026-07-05):** unlike Cursor's $20-seat≈$20-credits (all compute pass-through), our seat carries real software (hosted running instance, sandbox builds, collab) — e.g. $25 plan w/ $15 credits = honest ~$10 software margin covering sandbox COGS. Caution: Cursor-literate buyers compare credit-per-dollar → itemize visibly ("your always-on hosted designbook"), never let the plan read as "worse Cursor."

### Donations / OSS sponsorship — considered, rejected (2026-07-05)
Idea: prompt free CLI devs to donate / get their company to sponsor the OSS project.
- Pros: zero product cost; devs OSS-sympathetic; sleeper benefit — a sponsoring company self-identifies as a warm enterprise lead (sponsorship = top-of-funnel).
- Cons: revenue is immaterial even for huge projects (Babel peaked ~$300k/yr); "donate to a VC-backed startup" reads badly and breeds cynicism at first paywall/raise; positioning confusion (charity vs company); can delay conversions ("we sponsor, why buy seats?"); admin overhead.
- Verdict: skip literal donations on the venture path. Honest adjacent version: company **"OSS supporter" plan** (early access, roadmap voice, README logo) = paid tier in OSS-friendly clothes, converts same goodwill without mixed signals. Revisit if bootstrapped.

## Recommendation — best first option

**Build the hosted share link first: a branch designbook at a URL, with comments.** Rationale:
1. Smallest step from what exists (branch instances + server already run locally; hosting is packaging, not invention).
2. Monetizes the exact person who can't use the product today (designer/PM without a checkout) — new value, not repackaged value → zero open-core backlash.
3. Creates the surface every later SKU attaches to: review/approvals, background agents, governance dashboards, visual regression all live at that URL.
4. AI credits ride along from day one (metering in the hosted tier), so the Cursor axis starts accruing without its worst COGS risk — no always-on *inference*. (Hosted instances/sandbox builds are real always-on COGS, but attributable per account and covered by the seat's software base fee — see pricing decision.)

Sequence: hosted share links + comments → designer self-onboarding agent (GitHub connect) → pooled/metered agent credits in cloud → background branch instances → agentic workflows (Amplitude-style watchers) → governance/enterprise.

## Resolved
- **Buyer/adoption model** (2026-07-05): no single primary buyer — design, engineering, or product can all be the entry point; purchase decision sits higher in the org. Motion = bottom-up practitioner adoption (either persona, both front doors) → exec purchase. Pricing page speaks to practitioners; sales motion targets the budget holder.
- **BYOK**: allowed on unpaid plans (bottom-up enabler); bundled credits remain the default path.
- Hosted book v1 = **full running instance**, all functionality (self-onboarding requires building + rendering the repo; north star needs live agents in the environment). **Cost-reduction spike**: investigate running books in the *browser* instead of full server sandboxes — CodeSandbox's OSS runtime (Sandpack/Nodebox) or StackBlitz WebContainers (⚠️ commercial license for production use). Likely hybrid: render/Vite in browser, Pi agent + git server-side. Evaluate performance + COGS.
- **Background-agent pricing**: run-credit based w/ margin (decided in principle; details deferred).
- **Free-tier credit sizing principle**: enough to complete ~2–3 real tasks; exact number calibrated from usage data post-launch.
- **Monetization timing**: decision deferred.
- **Free tier includes hosted** (2026-07-05): self-onboarded designers land hosted, not local — free ≠ pure OSS/local. Cost control: scale-to-zero instances (hibernate on idle, wake on visit), scoped import caps build minutes.
- **Prepaid credit packs sellable on every tier incl. free** — margin from day zero; BYOK demoted to power-user escape hatch (half-answers open Q2).
- Free tier shape = **daily credit drip + monthly cap**; onboarding open to any user, deduped per repo.
- Pricing structure = **software base fee > included credits** (e.g. $25 seat / $15 credits) to cover sandbox/instance COGS.
- **No split brand** (OSS vs cloud); donations rejected on venture path.

## Unresolved questions
1. Monetize pre- or post-OSS traction (launch order: OSS launch first?) — deferred by choice.
2. Free-tier drip numbers (per-day + monthly cap) — calibrate from usage once live.
3. Name: shortlist to pursue for ™/domain diligence (Refract? Beamline? keep designbook?)
4. Browser-runtime spike outcome: Sandpack/Nodebox/WebContainers viability + licensing vs server sandbox COGS.
