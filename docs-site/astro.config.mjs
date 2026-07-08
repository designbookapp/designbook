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
      tagline: "Design your product, not pictures of it",
      description:
        "Designbook is a design workbench for React repos: a live component canvas plus an embedded coding agent that turns design edits into real code.",
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
            { label: "Canvas & flows", slug: "concepts/canvas-and-flows" },
            { label: "Component sets", slug: "concepts/component-sets" },
            { label: "Selection & drill-in", slug: "concepts/selection" },
            { label: "Code panel", slug: "concepts/code-panel" },
            { label: "The Pi agent", slug: "concepts/agent" },
            { label: "Live-app editing", slug: "concepts/page-tools" },
          ],
        },
        {
          label: "Configuration reference",
          items: [
            { label: "defineConfig", slug: "config/define-config" },
            { label: "fromGlob & lazy entries", slug: "config/from-glob" },
            { label: "Component sets & overrides", slug: "config/sets-and-overrides" },
            { label: "Flows & wireframes", slug: "config/flows" },
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
            { label: "Troubleshooting", slug: "reference/troubleshooting" },
          ],
        },
      ],
    }),
  ],
});
