# Marketing direction — hosted launch

_2026-07-05. Companion to [monetization.md](./monetization.md). Site brand uses candidate name **Refract** (easily swappable; see naming note in monetization doc)._

## Positioning

**One-liner:** Stop designing pictures of your product. Design the product.

**Category:** the design tool that edits your real product — live components, real data, real code underneath. Not a mockup tool, not a code editor: the bounded editing layer between them.

**Against:**
- Figma: pictures drift from the product the moment they ship. We *are* the product.
- Storybook: built for devs to view components; we let designers *change* them, safely.
- Cursor/AI codegen: prose in, code out, trust unknown. We give bounded surfaces — every edit constrained, diffable, reviewable.

## Audiences (in message priority)
1. **Designers** — emotional core: "edit the real thing, no more handoff."
2. **Design engineers / frontend devs** — credibility: "code stays source of truth; edits arrive as PRs; boundaries you define."
3. **PMs** — "review live branches at a URL; agents that watch your funnels" (background agents teased as coming-soon).
4. **Eng leadership** — trust: guardrails, audit, nothing lands without review.

## Key messages for the site (in scroll order)
1. **Hero**: live canvas of real components, theme/locale/flags switching live. "Design the product, not pictures of it." CTA: *Connect your GitHub repo* (+ secondary: `npm i designbook`).
2. **Self-onboarding**: connect repo → agent reads it → your designbook renders in minutes. No local setup, no config written by hand.
3. **Edit for real, safely**: tokens/theme, copy in every language, feature flags per tenant — bounded surfaces, instant preview, undo everything. (Adapters = the concept, shown not named.)
4. **The agent applies it as code**: describe a change or pull design edits — get a reviewable diff/PR, never a mystery write.
5. **Figma round-trip**: push components to Figma as native, editable layers (variables bound, components/instances); pull the designer's edits back; agent applies them.
6. **Every branch, a URL**: branch designbooks with share links; comment and review with the team. PR previews for design.
7. **Engineers stay in control**: code is the source of truth; boundaries defined in one config file; full diff trail. (Trust section — quieter design.)
8. **Coming soon tease**: background agents (funnel-watching PM agent) + configuration-first future (data models, contracts).
9. **Pricing** (illustrative): Free (hosted starter + full local tool, daily credits) / Pro $25 (incl. $15 credits) / Team $40/editor (branch books, review, pooled credits) / Enterprise (SSO, self-host, governance). Credit packs on every plan.
10. **Footer CTA**: "Your product is already the design file. Open it."

## Voice & visual direction
- **Designer-led, energetic** — Figma/Sketch lineage, not dev-tool austere. Bold display type, saturated accent palette (prism/refraction motif: light split into bands), playful micro-interactions, generous whitespace.
- Product-first visuals: the app IS the imagery — canvas, panels, Figma sync, chat. No abstract stock illustration.
- **Scroll journey w/ parallax**: scrolling moves you *through* the app — hero canvas zooms/pans between feature vignettes (theme edit → text edit → flag flip → Figma push → PR diff) as panels slide in at different depths. Feature idea, not strict requirement.
- Dark-on-light default with vivid refracted-spectrum accents; code moments shown in dark panels for contrast.

## Launch plan (hosted)
1. **Pre-launch**: OSS launch first builds the wedge — Show HN, dev Twitter/X, Storybook-comparison blog post ("Storybook lets devs view; this lets designers change").
2. **Hosted launch**: Product Hunt + design Twitter/X + designer newsletters (Dive Club, Design Details-adjacent); 90-sec demo video of the full loop (connect repo → edit → Figma round-trip → PR merged).
3. **Content engine**: "handoff is dead" essay series; adapter-of-the-week posts; live-rebuild streams of famous UIs in designbook.
4. **Community loop**: adapter-gap telemetry → public roadmap voting (paid preference) → "you asked, we shipped" posts.
5. **Metric**: repos connected → books shared → first credit purchase. North-star: weekly designers editing real products.
