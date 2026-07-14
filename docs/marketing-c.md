# Marketing direction C — "One product. Every angle."

_2026-07-09. Third variant, alongside [marketing.md](./marketing.md) (A: "design the product, not pictures") and [marketing-b.md](./marketing-b.md) (B: "everyone builds the product"). C is derived from the lens/zoom mental model in [brand-concept.md](./brand-concept.md). Site at `marketing/c/index.html`. Brand uses **designbook** (working name; "Refract" retired)._

## The insight
One codebase, many true views. Each discipline (design, product, eng, content) looks at the same product from its own angle — like the plan/elevation/section drawings of one building: each drawn for a different trade, each undistorted, only together do they describe the whole. Overview first, zoom when needed. Two payoffs: changes from other disciplines are skimmable at a glance (drill in only when they touch your layer), and AI agents can make sweeping internal changes while humans supervise at the structural level.

## Positioning (C)
**One-liner:** One product. Every angle.

**Category:** the product development tool for the whole team — one structure, a live view per discipline, at any zoom level. NOT a design tool; not annotation/planning. Every view is derived from the running code, and every edit lands back in the codebase.

**Vocabulary (in-product and on-site):**
- Drawing set / sheets — the per-discipline views. Mapping: **Plan = product** (flows, flags), **Elevation = design** (tokens, variants), **Section = engineering** (code, diffs, config), **Schedule = content** (strings per locale). Sheet numbers used as section eyebrows (A-201, P-101, S-301, C-401).
- **Clash detection** (BIM) — "designbook runs clash detection on every PR." Cross-lens impact flagged before review.
- **Load-bearing** — change-classification vocabulary ("touches nothing load-bearing").
- Tomography line, used verbatim in views section: "No single view shows the whole product — the views together are the product."
- Zoom scale as UI copy: 1:100 (overview) ↔ 1:1 (detail); the agent quote reuses it.

## Narrative arc (scroll order)
1. **Hero:** "One product. Every angle." + dimension-line annotation ("one codebase, end to end"). Sub names all four readers and cashes out: edit your sheet → change lands in the codebase → other views update. CTAs: Connect GitHub / `npm i designbook`.
2. **Interactive drawing set** (centerpiece): one sheet of `acme/meridian`. Lens tabs (A Design / P Product / S Engineering / C Content) re-highlight the same app map; zoom control moves 1:100 overview (route/screen map with per-discipline chips, legend, per-lens annotations) ↔ 1:1 detail (token row in `tokens.css`, flag JSON, `BookingPay.tsx`, locale string ×3). Title block updates live (sheet no, view name, scale; "DERIVED from main · live, not drawn"). Lenses auto-cycle gently until first interaction (off under reduced motion).
3. **How to read the set:** Plan/Elevation/Section/Schedule cards, verb-first ("Walk the flows." "Read the surface." "Cut through the structure." "Read every word in place."), each cashing out in a mechanism (flag JSON, tokens.css, adapter config, locale file). Footnote: "Lenses filter attention, not access."
4. **Clash detection (change feed):** one branch (`meridian/checkout-v2`) read through four lenses — Design SKIM, Product SKIM, Engineering FULL SECTION, Content **CLASH / LOAD-BEARING** (German CTA overflows the narrowed button; card carries a red CLASH stamp). Each card zooms to a real diff (token diff, flag diff, locale measurement, file list). Closes with the flooring principle: "when the flooring changes, the electrician skims — unless there are outlets in the floor. designbook finds the outlets."
5. **Agents:** "Agents work at 1:1. You supervise at 1:100." Dark blueprint section; agent run panel (42 files rewritten, structural readout: routes ✓ surfaces ✓ fixtures ✓, one load-bearing change flagged with ZOOM 1:1). Message: zoom is the review; most days the readout says "not your layer."
6. **Spec — "Derived from code. Never drawn.":** trust list (npm plugin in the real app; adapters/one config; every edit lands as code; branch sets at URLs; **Figma is a projection, not a source**) + `designbook.config.ts` pane + 3-step self-onboarding strip (Connect / Derive / Read).
7. **Quote:** VP Eng — "watched it at 1:100, zoomed in exactly twice" (sells the agent payoff, not the design payoff).
8. **Pricing:** same illustrative plans as A/B (Free / Pro $25 incl. $15 credits / Team $40 / Enterprise; credit packs everywhere). Eyebrow "Schedule of rates" (a schedule is a real drawing-set document). Team is the featured plan — C's promise is team-wide.
9. **Footer CTA:** "Your codebase already contains every view." / "Connect the repo. Read the set."

## Voice & visual direction (C — deliberately distinct from A and B)
- **Drafting-set aesthetic:** cool vellum paper (#F7F7F3), graphite ink, hairline rules, faint graph grid, crosshair registration marks, title block, scale bar, stacked-sheet edges behind the hero sheet. A was prism-spectrum energy; B was warm multiplayer; C is **calm, measured, instrument-like** (Linear-ish register, verb-first lines).
- Discipline colors as CAD pen colors: design blue #3557E8, product amber #B85C00, engineering green #0E7A55, content violet #7C3AE3; **redline #CF3018 reserved for clash/load-bearing only**.
- Type: Avenir Next/system sans for display and body; monospace uppercase carries all drafting annotation (eyebrows = sheet numbers, title block, legends, statuses). Signature type moment: dimension-line underneath the H1.
- Dark sections are **blueprint navy** (#0F1D33) with faint grid — cyanotype nod — used for agents, config pane, footer CTA.
- Interactions all vanilla JS: lens switch, zoom, feed-card expand, npm copy, scroll reveal; sheet scales to fit (checked at 390px); everything respects `prefers-reduced-motion`.

## Message discipline
- Never "no engineers needed"; never "empower". The promise is *read everything, edit your layer, safely* — engineers own the config and review.
- PRs mentioned sparingly; "clash detection on every PR" is the one loud use.
- Every abstract line cashes out in a mechanism: token = CSS custom property, headline = locale-file key, flag = JSON, agent run = readable diffs, branch = preview URL.
- The overview is always described as **derived** — never a drawn artifact, never annotation/planning.
- Boundaries de-emphasized vs. A/B; the lead is angles + zoom ("filter attention, not access").
