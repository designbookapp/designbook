# marketing/videos

Instructional/explainer video assets for designbook (site brand: **Refract**,
see `docs/marketing.md`), authored with **egaki**.

## What egaki actually is

egaki (github.com/remorses/egaki) is a TypeScript CLI + MDX-to-video
**compositing** framework built on Remotion and the Vercel AI SDK. It is
**not** a screen-recording tool and **not** an AI text-to-video generator on
its own — those are two separate, combinable capabilities it happens to
bundle:

1. **AI media generation** (`egaki image`, `egaki video`, `egaki speech`,
   `egaki transcribe`, `egaki voice clone`, `egaki demucs`, `egaki bpm`) — CLI
   commands that call out to Imagen/Veo/GPT/Grok/Kling/ElevenLabs/Cartesia
   etc. Useful for b-roll, stock-style clips, or narration audio, not for
   depicting our actual UI.
2. **MDX-to-video authoring** — the part we use. You write a `video.mdx` file:
   YAML frontmatter (`fps`, `bpm`) + `#` headings that become timed Remotion
   `<Series.Sequence>` scenes + arbitrary JSX/React inside each scene. It
   compiles through a Vite plugin and previews in an interactive
   `<Player>` (scrubber, live tweak panel). There is no separate DSL beyond
   MDX + a handful of built-in components.

Verified against real examples in the repo (not just the README):

```mdx
---
fps: 30
---

import { AcmePromo } from './components'

# Acme Promo duration=4s

<Background>
  <div style={{ width: '100%', height: '100%', background: '#506c53' }} />
</Background>

<AcmePromo />
```
— `acme-example/video.mdx`, https://raw.githubusercontent.com/remorses/egaki/main/acme-example/video.mdx

```ts
// acme-example/vite.config.ts
import { video } from 'egaki/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [video({ entry: './video.mdx' })],
})
```
(Note: the README's own prose names the plugin `egakiPlugin`; the actual
shipped examples import it as `video` from `egaki/vite`. We use the grounded
one.)

Primitives confirmed by reading real example sources (not invented):
- **Animators**: `Opacity`, `Scale`, `TranslateX`, `TranslateY`, `Blur` — each
  takes `from`/`to`/`duration`/`startInFrames`/`easing`. Easing presets
  (`smooth`, `natural`, `decelerate`, `elasticSnap`, `overshoot(63)`, …) come
  from `egaki/video`, not raw Remotion.
- **Sections**: `# Heading duration=4s` (or `8beats`, `90frames`, raw frames).
  No explicit duration → auto-sized to longest media.
- **`<CodeBlock>`** (from `egaki/video`, via shiki) — syntax-highlighted code
  with `theme`, `highlightLines`, `staggerFrames` (typing reveal), and
  scale/zoom animation via `interpolate()`. Confirmed in
  `code-block-example/components.tsx` (ThemeGrid, HighlightDemo,
  AnimatedCodeBlock, ZoomingCodeBlock, …). **This is our primary tool for
  showing code/config/locale-file changes natively in egaki**, no screen
  capture needed.
- **`<Video>` / `<Audio>`** (from `@remotion/media`) — import real files:
  `<Video src="clip.mp4" objectFit="cover" muted loop trimBefore={..} />`.
  **This is how we get our actual app UI into the video** — egaki has no
  primitive that simulates/draws arbitrary live app screens, so real UI
  interactions (pill click, live selection, in-place text edit) must be
  **real screen recordings** composited as `<Video>`, not egaki-drawn.
- **Captions**: no single magic auto-sync tag in the examples we read —
  `captions-example/components.tsx` hand-rolls `CaptionOverlay` /
  `WordPopCaptions` from a `Caption[]` array (`text/startMs/endMs`) driven by
  `useCurrentFrame()`/`useVideoConfig()`, with the comment "in production use
  Whisper transcription output." Get that array via `egaki transcribe` on
  narration audio (word-level timestamps), or hand-time a short script.
  (README also lists a `<Caption>` component with word-level timing — treat
  as available but unverified against source; the hand-rolled pattern is the
  one we've actually seen work.)
- **`<LayoutTransition id="x">`**: FLIP-style match-by-id animation across
  scene boundaries — good for e.g. the toolbar pill morphing into the tool
  strip between scenes.

## Render / export workflow

- `pnpm dev` in a project with the Vite plugin opens the interactive Player
  (scrubber + tweakpane).
- Export is **browser-driven**: an "Export MP4" button in the Player uses
  `renderMediaOnWeb()` from `@remotion/web-renderer` — WebCodecs, in-browser
  H.264 encode, **no ffmpeg, Chromium only**.
- No documented ffmpeg-style CLI render command. For scripted/headless export
  (CI, or scripting our own render), `AGENTS.md` documents driving the same
  export from a controlled browser: `window.egakiSDK.export({ frameRange,
  path })` called via a Playwright-style page-eval. We haven't exercised this
  ourselves — treat as a documented but unverified path.

Sources fetched: https://raw.githubusercontent.com/remorses/egaki/main/README.md,
`AGENTS.md`, `cli/package.json` (name `egaki`, v0.8.0, bin `dist/cli/main.js`),
and the four example projects cited above (`acme-example`, `captions-example`,
`release-notes-example`, `code-block-example`) — chosen because they're the
most-grounded, runnable sources in the repo, not the README's prose alone.

## Does egaki fit this job?

**Yes, with a hybrid approach** — egaki is not a screencast tool, so it can't
draw "the live app" for us. But it's a solid **compositor**: it takes our real
screen recordings (`<Video>`), our real code/config snippets (`<CodeBlock>`,
which we can grab verbatim from this repo), and layers titles, captions,
transitions, and narration timing on top, all in code (versionable, diffable,
re-renderable when the product UI changes). That's exactly what an explainer
video needs, and it beats a general NLE for this because scenes stay text/
diffable and easy to re-cut when a UI screenshot goes stale.

If it turns out the browser-export path is too fragile for us, the fallback
is: use egaki only for the **title/code/caption scenes** and cut the final
video in a normal NLE (Premiere/DaVinci/Descript), dropping the screen
recordings in around egaki's rendered segments. Noted as a fallback, not
needed as a first choice — see `instruction-video-plan.md`.

## How to author/render a video here

1. Prerequisites: Node + pnpm, a Chromium-based browser (export requires
   WebCodecs/Chromium), API keys only if you use AI media generation
   (`egaki login --provider ...`) — not required for the plan in this folder,
   which uses real screen recordings + code snippets, no generated media.
2. Scaffold (see `video.mdx` / `package.json` / `vite.config.ts` in this
   folder — a minimal starter, title scene only, marked as a stub):
   ```bash
   cd marketing/videos
   pnpm install
   pnpm dev        # opens the egaki Player at the printed localhost URL
   ```
3. Drop screen recordings into `marketing/videos/assets/clips/` (create the
   dir; gitignored — see asset checklist in the plan) and reference them with
   `<Video src="./assets/clips/xyz.mp4" />`.
4. Export via the Player's "Export MP4" button (Chromium). Re-render anytime
   the product UI changes by swapping the clip and re-exporting — the rest of
   the composition (titles, captions, timing) doesn't need to change.

See `instruction-video-plan.md` for the actual scene-by-scene plan, script,
and production task list.
