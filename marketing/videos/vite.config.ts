// STUB — Vite config for the designbook explainer video (egaki MDX-to-video).
// Pattern verbatim from egaki's own acme-example/vite.config.ts:
// https://raw.githubusercontent.com/remorses/egaki/main/acme-example/vite.config.ts
import { video } from 'egaki/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [video({ entry: './video.mdx' })],
})
