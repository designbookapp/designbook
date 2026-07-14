// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://starlight.astro.build/reference/configuration/
export default defineConfig({
  site: "https://docs.designbook.app",
  server: { port: 8881 },
  integrations: [
    starlight({
      title: "Designbook",
      tagline: "One product. Every angle.",
      description:
        "Designbook opens your running React app as one full view with a live editing surface per discipline — tokens, copy, flags, code — plus an embedded coding agent that lands every edit as real code.",
      customCss: ["./src/styles/custom.css"],
      social: [],
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "What is Designbook?", slug: "getting-started/what-is-designbook" },
            { label: "Install & run", slug: "getting-started/install-and-run" },
            { label: "Injected mode", slug: "getting-started/injected-mode" },
            { label: "Your first config", slug: "getting-started/first-config" },
          ],
        },
        {
          label: "Core concepts",
          items: [
            { label: "The full view", slug: "concepts/full-view" },
            { label: "Component registration", slug: "concepts/component-sets" },
            { label: "Selection & drill-in", slug: "concepts/selection" },
            { label: "Chat & the Pi agent", slug: "concepts/agent" },
            { label: "Changesets & the Changes panel", slug: "concepts/changesets" },
            { label: "History explorer", slug: "concepts/history" },
            { label: "Props panel", slug: "concepts/props-panel" },
            { label: "Code panel", slug: "concepts/code-panel" },
          ],
        },
        {
          label: "Configuration reference",
          items: [
            { label: "defineConfig", slug: "config/define-config" },
            { label: "fromGlob & lazy entries", slug: "config/from-glob" },
            { label: "Component sets & overrides", slug: "config/sets-and-overrides" },
            { label: "Flows (deprecated)", slug: "config/flows" },
          ],
        },
        {
          label: "Adapters",
          items: [
            { label: "Overview", slug: "adapters/overview" },
            { label: "Theme", slug: "adapters/theme" },
            { label: "Text & i18next", slug: "adapters/text" },
            { label: "Flags", slug: "adapters/flags" },
            { label: "Custom adapters", slug: "adapters/custom" },
          ],
        },
        {
          label: "Using with your repo",
          items: [
            { label: "Vite compatibility", slug: "repo/compat" },
            { label: "Tailwind", slug: "repo/tailwind" },
            { label: "Monorepos", slug: "repo/monorepos" },
            { label: "Next.js", slug: "repo/nextjs" },
          ],
        },
        {
          label: "Figma integration",
          slug: "figma",
        },
        {
          label: "Branch instances",
          slug: "branch-instances",
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "reference/cli" },
            { label: "designbook init", slug: "reference/init" },
            { label: "designbook dev", slug: "reference/designbook-dev" },
            { label: "Security & trust model", slug: "reference/security" },
            { label: "Integration plugins (experimental)", slug: "reference/integration-plugins" },
            { label: "Troubleshooting", slug: "reference/troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
