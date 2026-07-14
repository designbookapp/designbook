# Brand concept + naming (2026-07-09 session)

Status: mental model settled enough to prototype; name still open (designbook remains placeholder/actual).

## Mental model

**The app seen from different angles, at any zoom level.**

- One structure (the codebase), many true views. Each discipline (design, PM, eng, content) looks at the same product from its own angle — like plan/elevation/section drawings of one building: each drawn for a different trade, each undistorted, only together do they fully describe the structure.
- **Overview first, zoom when needed.** Everyone can see how the whole fits together at a high level; drill into detail only where it concerns you.
- Two payoffs of the high-level view:
  1. Changes from other disciplines are visible at a glance — skim past what doesn't apply, drill in when it might ("the flooring will change" — the electrician can skim or flag floor outlets).
  2. Same for AI agents: they can make sweeping changes to inner workings; humans watch at the structural level and inspect the internals through the zoom when needed.
- PRs are NOT split or access-gated — one change, *presented* through discipline lenses. Filter attention, not access.
- The overview/blueprint is DERIVED from code (living, always current), never a parallel drawn artifact. Avoid "annotation/planning" framing — this is a thing you change and the building changes.
- Emphasis shifted over the session: boundaries/ownership de-emphasized; angles/lenses + zoom in-out is the core.

Pitch metaphors that tested well in discussion:
- Construction drawing set (plan / elevation / section) — candidate in-product vocabulary for the per-role views.
- Clash detection (BIM): "designbook runs clash detection on every PR."
- Tomography: no single view shows the whole product; the views together *are* the product.
- "Load-bearing" as change-classification vocabulary ("this diff touches nothing load-bearing").

## Naming rounds (all rejected, with reasons)

- **Blueprint** — Pega GenAI Blueprint (live class-42 mark, AI app-design), generic/crowded register, SEO. Use as category language only.
- **Prism** (revisited) — prism.com merely parked and OpenAI Prism (LaTeX sci workspace) is a different field, but killed anyway: Prisma ORM + Prism.js sit exactly in our dev audience (SEO/npm/distinctiveness), crowded class 9 (GraphPad PRISM live), NSA joke.
- **Refract** — sound. **Beamline** — off-concept, insider physics.
- **Facet** — good meaning, bad sound ("faeces").
- **Keyplan** — orientation-only, not a workbench. **Maquette / Atrium / Armature / Orrery / Trellis / Lightwell / Partywall** — round on the boundaries-era model; superseded by lens pivot. Partywall kept as possible feature name.
- **Loupe** — best sound, but zoom-in only. Candidate *feature* name for the zoom gesture.
- **Parallax** — best story (angle differences → depth), crisp sound; killed: mainly its established meaning in design (parallax scrolling), secondarily angles-only.
- **Scope** — natively covers zoom + scope-of-work + dev usage, verbs well; Blueprint-tier generic (weak TM, dead prior Scopes).
- Observation: no single English word covers both angles and zoom (optics separates pan/tilt from zoom); the objects that do both are instruments (total station) and maps. Alternative stance: let the brand carry ONE image and put the rest in product vocabulary (loupe, elevations, sections, clash detection).

## Framing addendum: the architect + spec-driven development (later 2026-07-09)

Michael's riff: every discipline was always an *architect* of the application — but each had to hand their vision to an engineer to realize it. Handover = loss in translation + the architect never directly saw/owned what they created. Agents doing the work in real time remove the handover. Spec-driven development (spec-kit, Kiro, …) is the adjacent hot category, but its specs are unapproachable: markdown walls, code-based, no visualization, no altitude, no quick glance.

**Claim: designbook is spec-driven development where the spec is a drawing set** — derived from the running app (can't rot), readable by every discipline at a glance, editable at any altitude, executed by agents in real time, landing as a PR you authored. "The spec became a place, not a document."

Watch-outs:
- "Architect" is a senior-eng title — keep the architect idea metaphorical (building metaphor carries it), don't literally crown PMs "architects" in copy aimed at engineers.
- Agents relocate translation rather than remove it — honest pitch is "the feedback loop closed": the visionary sees the result instantly and iterates, instead of discovering loss weeks later. Rides on the same bet as wireframe tension #6 (diff must be renderable back at altitude).

## Live candidate: Angle (2026-07-09, end of session)

**Angle** — Michael's pick to keep alive. For: instantly understood; already the operative word in variant C's hero ("One product. Every angle."); journalism sense (story angle = per-discipline framing of one event); short/punchy. Zoom coverage: abstract but real — an angle itself has a narrow part (vertex) and a wide opening. Against (accepted, not blockers): angel/angle typo collision in startup-land; Google's ANGLE graphics layer + Angular adjacency in dev audience; "what's your angle" = hidden-agenda idiom; angles-only unless the wide/narrow reading carries zoom. Mechanics: npm `angle` taken (would scope anyway), angle.app/.dev/getangle.com registered; **getangle.dev available** (not great, something). Existing Angle companies (Angle Health, ANGLE plc) = clearable-tier, no Pega-style blocker.

Also ratified for copy regardless of name: "every angle" in hero; score metaphor (each discipline reads its own part, performed in real time) alongside the drawing set. Naming rounds also rejected (artifact/spec round): Baton, Charter, Folio, Manifest, Promptbook, Callsheet, Titleblock, Partita; Vellum revival killed by vellum.ai. Michael's target name shape: short, optical/concrete, hard ending (Prism, Parallax, Angle all fit profile).

## Open

- Name: **Angle** live candidate vs keep designbook. Diligence not yet run.
- designbook stays for now (npm `@designbookapp/designbook`, one brand OSS+cloud — both still locked).
- Hero copy: to be re-derived from the lens/zoom mental model (variant C in `marketing/c/`).
- Concept wireframe thought-experiment in `marketing/concept/`.
