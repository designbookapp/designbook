/**
 * The designbook config the fidelity harness runs against
 * (docs/specs/figma-sync-testing.md). A single `fidelity` set of tiny cases,
 * each a component whose registry id (`fidelity.<caseId>`) doubles as the
 * harness case id, route, and push `componentId` (see caseConfig.ts).
 *
 * Cases use inline `style={{}}` for exact static CSS (no Tailwind compilation
 * variance); `token-colors` uses `var(--fidelity-*)` so the themeAdapter's
 * Figma token source attributes them. Kept structurally minimal — the sidecar
 * MUST load this file for any run, so it avoids the registry-TDZ wrinkle the
 * dogfood config documents (no case imports the component registry).
 *
 * Run it standalone for authoring:
 *   node dist/cli/index.js test/figma-fidelity/fidelity.config.tsx --port 8791 --no-open
 */
import { defineConfig } from "@designbookapp/designbook/config";
import { themeAdapter } from "@designbookapp/designbook/adapters";
import "./theme.css";
import { SolidBg } from "./cases/solid-bg/Case";
import { TextBasic } from "./cases/text-basic/Case";
import { FlexJustifyAlign } from "./cases/flex-justify-align/Case";
import { AbsoluteBadges } from "./cases/absolute-badges/Case";
import { TokenColors } from "./cases/token-colors/Case";

export default defineConfig({
  title: "Figma fidelity",

  sets: [
    {
      id: "fidelity",
      title: "Fidelity/Cases",
      // Keys are the case ids (caseConfig.ts). Registry id `fidelity.<id>`.
      components: {
        "solid-bg": SolidBg,
        "text-basic": TextBasic,
        "flex-justify-align": FlexJustifyAlign,
        "absolute-badges": AbsoluteBadges,
        "token-colors": TokenColors,
      },
    },
  ],

  adapters: [
    themeAdapter({
      source: "./theme.css",
      modes: { light: ":root" },
      // Registers the Figma token source so var()-driven colors/dimensions
      // attribute to data-token-* on serialize/pull. Sync the collection to
      // Figma once (Theme tab → "Sync to Figma") before the first run so the
      // bound variables exist.
      figma: { collection: "designbook/theme" },
    }),
  ],
});
