# Instruction video plan — designbook / Refract

_Grounded in `docs/runtime-topology.md`, `docs/specs/m-page-tools.md`,
`docs/specs/p-flow-iframes.md`, `docs/client-setup.md`, `examples/README.md`,
`marketing/index.html`, `docs/marketing.md`. egaki capabilities grounded in
`README.md`, and `acme-example/`, `captions-example/`,
`code-block-example/` source at github.com/remorses/egaki — see this folder's
`README.md` for citations. Note: `docs/marketing.md` already calls for a
"90-sec demo video of the full loop" at hosted launch — this plan is that
video._

## Target, audience, message

- **Core cut: ~90s.** Variants: **30s** cut-down (social/ad), **3min**
  deep-dive (docs site / sales).
- **Audience**: design/eng/PM leaders evaluating design tooling — priority
  order per `docs/marketing.md`: designers (emotional: "edit the real thing"),
  design engineers (credibility: "code stays source of truth, edits are
  diffs"), PMs (review at a URL), eng leadership (trust/guardrails).
- **Single core message**: *You're not looking at a picture of the product —
  you're looking at the product. Every edit lands as real code.*

## Storyboard — 90s core cut

Technique legend: **[EGAKI]** = drawn/composited natively in egaki (title
cards, `<CodeBlock>`, captions, transitions). **[CAPTURE]** = real screen
recording of the actual app, composited via `<Video>`.

| # | Time | Visual | egaki technique | Narration / caption | Dur |
|---|---|---|---|---|---|
| 1 | 0:00–0:04 | Black → wordmark "designbook" resolves from a soft spectrum bloom (matches hero's `--spectrum` gradient) | **[EGAKI]** title scene: `<Background>` gradient div + `<Opacity>`/`<Scale>` in on the wordmark, easing `smooth` | (no VO) Caption: "Design the product, not pictures of it." | 4s |
| 2 | 0:04–0:10 | Split screen: a Figma frame (static, muted) vs. the actual running app (live, colorful) — Figma side visibly stale/drifted | **[EGAKI]** two `<Fill>` panels, `TranslateX` slide-in from opposite edges, `duration=0.5*FPS` each | VO: "Mockups drift the moment you ship. This is your real app — as the design surface." | 6s |
| 3 | 0:10–0:16 | `vite.config.ts` with `designbookPlugin()` added, one line highlighted | **[EGAKI]** `<CodeBlock>` with `highlightLines`, `staggerFrames` typing reveal, theme matched to dark panels used elsewhere on the marketing site | VO: "One line in your Vite config." | 6s |
| 4 | 0:16–0:22 | Dev server boots; a small pill toolbar fades onto the corner of the running app | **[CAPTURE]** screen recording of `pnpm demo:app` (or a client fixture) booting, composited with `<Video>`; egaki adds an `Opacity`-in label callout "designbook pill" | VO: "It shows up right on your running app. Nothing to configure, nothing to open separately." | 6s |
| 5 | 0:22–0:30 | Click the pill → tool strip opens (select / text / chat / expand / close icons) | **[CAPTURE]** real interaction, `<Video>`; egaki overlays icon labels via `TranslateY`+`Opacity` pop-ins timed to the click | VO: "Click it. Select, edit text, chat, or go full canvas." | 8s |
| 6 | 0:30–0:38 | Select tool on; hover highlights components on the live page; click one → chip shows its registered name | **[CAPTURE]**; egaki draws a highlight-ring callout synced to the click frame (`Scale`+`Opacity`) since the capture itself won't have graphic polish | VO: "Select anything on the page. It knows exactly which component that is in your code." | 8s |
| 7 | 0:38–0:48 | Text tool on; click a live string, inline popover editor opens, type a new value, page updates instantly, no reload | **[CAPTURE]**, the money shot — real in-place edit (M2 in `docs/specs/m-page-tools.md`) | VO: "Turn on text. Click a string. Edit it right there — the live page updates, no reload." | 10s |
| 8 | 0:48–0:58 | Cut to the locale file: `en-US/app.json` diff, the exact key changing, one line highlighted, diff colors (red/green) | **[EGAKI]** `<CodeBlock>` diff-style highlight (`highlightLines` + before/after via two staggered `<CodeBlock>` instances or a single block with an animated highlight sweep) | VO: "That edit just landed in your real locale file. Not a shadow copy — the file your app already reads." | 10s |
| 9 | 0:58–1:08 | Back to the app: open the chat drawer ("Prompt Pi"), type a request, a reply streams in referencing the exact file/line | **[CAPTURE]** real chat drawer interaction | VO: "Need more than a string change? Prompt it. The agent already knows which file, which line." | 10s |
| 10 | 1:08–1:20 | Click "Expand" → the workbench opens full-screen: canvas of components, an "App" page showing the live route in a frame | **[CAPTURE]** expand transition, real | VO: "Go further any time — the full canvas, live flows, even this exact page, all still your real code." | 12s |
| 11 | 1:20–1:26 | Quick beat: a branch URL with a share icon, someone commenting on the live product in a browser tab | **[CAPTURE]** or **[EGAKI]** mocked browser chrome around a static frame if no real branch-preview capture exists yet | VO: "Every branch is a link your team can open and comment on." | 6s |
| 12 | 1:26–1:30 | Wordmark returns, `npm i designbook` pill, URL | **[EGAKI]** title scene mirroring scene 1, `LayoutTransition id="wordmark"` back from scene 1 for continuity | Caption only: "designbook — design the product." | 4s |

**Total: 90s** (12 scenes; sums to 1:30 exactly with the table above —
tighten scene 10/11 by ~2s in final cut if needed).

### 30s cut

Keep scenes 1, 4 (trim to 3s), 6 (trim to 4s), 7 (full, this is the hook, 10s),
8 (trim to 5s, just the highlighted line, no full diff build), 12 (3s). Drop
2, 3, 5, 9, 10, 11 entirely — one continuous sentence of narration instead of
per-scene VO: *"Your real app. Select anything, edit it live, it lands in
your code. designbook."*

### 3min deep-dive

Same spine, each scene ~2x duration, plus new scenes: full flag-flip demo (per
`marketing/index.html` "Flip flags per tenant"), the Figma push/pull round
trip (native layers out, PR back in — per `docs/marketing.md` message 5), and
a proper diff/PR review screen before the outro. Aimed at the docs site and
sales calls, not social.

## Voiceover script (90s cut)

> Mockups drift the moment you ship. This is your real app — as the design
> surface.
>
> One line in your Vite config.
>
> It shows up right on your running app. Nothing to configure, nothing to
> open separately.
>
> Click it. Select, edit text, chat, or go full canvas.
>
> Select anything on the page. It knows exactly which component that is in
> your code.
>
> Turn on text. Click a string. Edit it right there — the live page updates,
> no reload.
>
> That edit just landed in your real locale file. Not a shadow copy — the
> file your app already reads.
>
> Need more than a string change? Prompt it. The agent already knows which
> file, which line.
>
> Go further any time — the full canvas, live flows, even this exact page,
> all still your real code.
>
> Every branch is a link your team can open and comment on.
>
> designbook. Design the product, not pictures of it.

Copy rules followed (matching `marketing/index.html` / `docs/marketing.md`):
concrete verbs (click, select, edit, land, prompt), no buzzwords
("leverage," "seamless," "empower" — none used), short declarative sentences,
one-line payoff per scene, the site's own tagline closes the video verbatim.

## Asset checklist

**Real screen recordings needed (scenes 4, 5, 6, 7, 9, 10, and 11 unless
mocked):**
- [ ] Boot `examples/demo` (`pnpm demo:app` from repo root) or a client-style
  fixture (`examples/i18n-app` via `pnpm example:i18n` is likely cleanest for
  scene 7/8 since it's the react-i18next locale-write fixture called out in
  `examples/README.md`) — record pill appearing on load.
- [ ] Pill click → tool strip open (scene 5).
- [ ] Select tool: hover + click a real component, chip with registry label
  appears (scene 6) — per `docs/specs/m-page-tools.md` M1 accept criteria,
  e.g. selecting a registered component and seeing its label.
- [ ] Text tool: click a live string, popover editor, type, live update, no
  reload (scene 7) — the M2 accept criteria flow in
  `docs/specs/m-page-tools.md`. **This is the hero shot — budget the most
  retakes here.**
- [ ] Locale file open in an editor, the diff landing (can be captured live
  or reconstructed as a **[EGAKI]** `<CodeBlock>` from a real before/after
  pair — prefer the CodeBlock version for crisp diff coloring; see scene 8).
- [ ] Chat drawer: prompt typed, streamed reply referencing file/line
  (scene 9).
- [ ] Expand → full workbench canvas + "App" page live iframe (scene 10) —
  per `docs/specs/p-flow-iframes.md` P1 ("App" page entry point). **Only
  record this once P1 ships** (spec marks P1 timing as unresolved — see its
  "Unresolved" section item 1). Until then, cut scene 10 down to the existing
  full-canvas expand (already shipped) and drop the App-page beat.
- [ ] Branch-preview URL + comment UI (scene 11) — if this isn't built /
  screenshot-able yet, mock it as a static browser-chrome frame in egaki
  rather than faking a capture.

**egaki-drawn scenes (no capture needed):** 1, 2, 3, 8 (preferred), 12.

**Narration audio**: record VO normally (human voiceover recommended over
`egaki speech` TTS for a brand explainer — TTS is fine for iteration
scratch tracks); get word-level timestamps via `egaki transcribe` on the
final VO track to drive caption sync (pattern grounded in
`captions-example/components.tsx`).

**Assets live in** `marketing/videos/assets/` (create `clips/`, `audio/`,
`stills/` — add a `.gitignore` for raw capture footage; keep only the final
exported video and the egaki source under version control).

## Production task list + rough effort

1. **Scaffold + smoke-test egaki** (this folder's `video.mdx`/`package.json`
   already stubbed) — confirm `pnpm dev` opens the Player, confirm "Export
   MP4" works in a Chromium browser on this machine. ~0.5h.
2. **Record captures** (scenes 4–7, 9–10 at minimum) against
   `examples/i18n-app` or `examples/demo` — needs a clean run-through script
   per scene, several takes for scene 7. ~2–3h incl. retakes.
3. **Build egaki-drawn scenes** (1, 2, 3, 8, 12) — title/wordmark treatment
   matching `marketing/index.html`'s spectrum gradient + serif-italic accent
   word style, `<CodeBlock>` scenes with real snippets pulled from this repo
   (`vite.config.ts` example, a real locale-file before/after). ~2–3h.
4. **Record/produce narration** — script above, human VO preferred; run
   through `egaki transcribe` for caption timing. ~1h + turnaround.
5. **Assemble composition** — sequence scenes in `video.mdx`, wire
   `<LayoutTransition>` for the wordmark bookend, sync captions, tune easing.
   ~2–3h.
6. **Export + review cuts** (90s, 30s, 3min) — re-render per variant; check
   against `docs/marketing.md` message order once more before calling it
   done. ~1h.

**Rough total: ~1–1.5 days** for the 90s cut; +½ day for the 30s and 3min
variants once the 90s asset set exists (mostly re-trimming, not re-shooting).

## Open questions

- P1 (App page) ship date vs video ship date — scene 10 depends on it. cut now w/o App-page beat, or wait?
- who's doing VO: human record or TTS placeholder for now?
- confirm "Refract" vs "designbook" as the spoken/on-screen brand name for this video — site uses Refract, repo/CLI is designbook.
- egaki browser-export (WebCodecs/Chromium) untested by us — worth a smoke-test before committing to it over a normal NLE?
