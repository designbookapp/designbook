import { defineConfig, type Adapter } from "@designbookapp/designbook/config";
import { themeAdapter } from "@designbookapp/designbook/adapters";
import type { ReactNode } from "react";
// Relative source imports: twenty-ui's package exports point at unbuilt dist/,
// and its `@ui/*` tsconfig alias is only valid for importers inside twenty-ui
// (importer-aware tsconfig-paths — correct behavior). Once inside twenty-ui
// source, internal `@ui/*` imports resolve via its own tsconfig.
import { Button } from "../twenty-ui/src/input/Button/Button";
import { MainButton } from "../twenty-ui/src/input/MainButton/MainButton";
import { Toggle } from "../twenty-ui/src/input/Toggle/Toggle";
import { Chip, ChipVariant, ChipAccent } from "../twenty-ui/src/data-display/Chip/Chip";
import { Pill } from "../twenty-ui/src/data-display/Pill/Pill";
import { Tag } from "../twenty-ui/src/data-display/Tag/Tag";
import { ThemeProvider } from "../twenty-ui/src/theme-constants/ThemeProvider";
import { IconCheck, IconStar, IconUser, IconRocket } from "../twenty-ui/src/icon";
// twenty-front component: Lingui macro + `@/` tsconfig alias + `twenty-ui/*`
// package-subpath imports — round-2 blocker probe.
// twenty-front components need Linaria transform from their unloadable vite config (sidecar plugins) — round-3

// ThemeProvider's applyColorSchemeClass only toggles a `.light`/`.dark` class
// on <html> — the actual `--t-*` design-token values (colors, spacing, icon
// sizes) are defined under those classes in these two stylesheets. twenty-
// front's own app entry pulls them in separately; without them every
// Button/Chip/Pill/Tag var falls back to `transparent`/unset and icons
// render unsized (hence the giant unstyled rocket/checkmark glyphs).
import "../twenty-ui/src/theme-constants/theme-light.css";
import "../twenty-ui/src/theme-constants/theme-dark.css";

// Plain row layout so multi-variant demos read as a comparison strip rather
// than a stack. No theme wiring here — that's the themeModeSync adapter below,
// which needs the live `theme:mode` context to pick light/dark.
function TwentyLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: 24, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
      {children}
    </div>
  );
}

// Reconciles designbook's `theme:mode` dimension (from `themeAdapter` below)
// with twenty-ui's own ThemeProvider, whose `colorScheme` prop toggles the
// real `.light`/`.dark` classes on <html> (applyColorSchemeClass). Without
// this, flipping the canvas's dark-mode toggle would only recolor tokens the
// designer has individually edited (via the injected `.designbook-theme.dark`
// override style) — every *unedited* token would keep following whatever
// class ThemeProvider left on <html>, so the rest of the UI wouldn't actually
// switch. This is a plain `Adapter` (no dimensions/tabs of its own) — just a
// `setup().Provider` that reads the aggregated context designbook already
// tracks and renders the real theme component around the preview.
const themeModeSyncAdapter: Adapter = {
  name: "themeModeSync",
  async setup() {
    return {
      Provider: ({ context, children }) => {
        const mode = context["theme:mode"] === "dark" ? "dark" : "light";
        return <ThemeProvider colorScheme={mode}>{children}</ThemeProvider>;
      },
    };
  },
};

const ButtonDemo = () => (
  <div style={{ display: "flex", gap: 8 }}>
    <Button title="Create record" variant="primary" accent="blue" Icon={IconRocket} />
    <Button title="Save changes" variant="secondary" />
    <Button title="Delete" variant="secondary" accent="danger" Icon={IconCheck} />
    <Button title="Coming soon" variant="tertiary" soon />
  </div>
);

const MainButtonDemo = () => (
  <div style={{ display: "flex", gap: 8 }}>
    <MainButton title="New opportunity" variant="primary" Icon={IconRocket} />
    <MainButton title="Import CSV" variant="secondary" />
  </div>
);

const ToggleDemo = () => (
  <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
    <Toggle value={true} toggleSize="medium" aria-label="Notifications enabled" />
    <Toggle value={false} toggleSize="small" aria-label="Auto-assign disabled" />
  </div>
);

const ChipDemo = () => (
  <div style={{ display: "flex", gap: 8 }}>
    <Chip label="In Progress" variant={ChipVariant.Highlighted} />
    <Chip label="Backend" variant={ChipVariant.Regular} />
    <Chip label="Read only" variant={ChipVariant.Transparent} accent={ChipAccent.TextSecondary} />
  </div>
);

const PillDemo = () => (
  <div style={{ display: "flex", gap: 8 }}>
    <Pill label="42 records" />
    <Pill label="Starred" Icon={IconStar} />
    <Pill label="Assigned to Ada" Icon={IconUser} />
  </div>
);

const TagDemo = () => (
  <div style={{ display: "flex", gap: 8 }}>
    <Tag text="Customer" color="blue" />
    <Tag text="Won" color="green" variant="solid" />
    <Tag text="At risk" color="red" variant="outline" />
    <Tag text="Draft" color="gray" variant="border" />
  </div>
);

export default defineConfig({
  title: "Twenty",

  // Maps registered components to repo files so the code panel shows source.
  sourceModules: import.meta.glob(
    [
      "../twenty-ui/src/input/Button/Button.tsx",
      "../twenty-ui/src/input/MainButton/MainButton.tsx",
      "../twenty-ui/src/input/Toggle/Toggle.tsx",
      "../twenty-ui/src/data-display/Chip/Chip.tsx",
      "../twenty-ui/src/data-display/Pill/Pill.tsx",
      "../twenty-ui/src/data-display/Tag/Tag.tsx",
    ],
    { eager: true },
  ),
  providers: [TwentyLayout],
  adapters: [
    // Points at a generated merge of twenty-ui's theme-light.css +
    // theme-dark.css (see designbook.theme.merged.css next to this config).
    // SDK gap: `themeAdapter.source` is a single css path with a single set
    // of `modes` selectors read from THAT file — it has no way to target one
    // file per mode. Twenty splits every token across two real per-mode
    // files (`theme-light.css` has only `.light{}`, `theme-dark.css` has only
    // `.dark{}`), so neither file alone has both blocks the adapter needs.
    // The merge is a config-level workaround (concatenation, generated once
    // by `./generate-theme-merge.sh` next to this config) — edits made
    // in the canvas persist to the MERGED file, not the two real per-mode
    // files, because the adapter's write path (`POST /api/style`) only knows
    // one `path` for all modes. See the round-3 report for the suggested
    // core fix (`source`/write-target as a per-mode map).
    themeAdapter({
      source: "./designbook.theme.merged.css",
      modes: { light: ".light", dark: ".dark" },
    }),
    themeModeSyncAdapter,
  ],
  sets: [
    {
      id: "primitives",
      title: "twenty-ui/Primitives",
      components: {
        Button: ButtonDemo,
        MainButton: MainButtonDemo,
        Toggle: ToggleDemo,
        Chip: ChipDemo,
        Pill: PillDemo,
        Tag: TagDemo,
      },
      // Demo wrappers live in this file; point the code panel at the real sources.
      overrides: {
        Button: { sourcePath: "packages/twenty-ui/src/input/Button/Button.tsx" },
        MainButton: { sourcePath: "packages/twenty-ui/src/input/MainButton/MainButton.tsx" },
        Toggle: { sourcePath: "packages/twenty-ui/src/input/Toggle/Toggle.tsx" },
        Chip: { sourcePath: "packages/twenty-ui/src/data-display/Chip/Chip.tsx" },
        Pill: { sourcePath: "packages/twenty-ui/src/data-display/Pill/Pill.tsx" },
        Tag: { sourcePath: "packages/twenty-ui/src/data-display/Tag/Tag.tsx" },
      },
    },
  ],
});
