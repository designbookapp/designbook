import { defineConfig } from "@designbookapp/designbook/config";
import { flagsAdapter, themeAdapter } from "@designbookapp/designbook/adapters";
import "./src/index.css";
import { FlagsProvider } from "./src/providers/FlagsProvider";

// The slim config (config-slim spec): no component registration — the vite
// plugin auto-indexes every exported component in the app's module graph, so
// selection/drill boundaries, labels and code attribution are all derived.
// Previews run in the live app, which brings its own providers and data.
export default defineConfig({
  title: "Demo Shop",

  adapters: [
    themeAdapter({
      source: "./src/index.css",
      modes: { light: ":root", dark: ".dark" },
      variants: {
        source: import.meta.glob("./src/themes.json", {
          eager: true,
          import: "default",
        }),
        sourcePath: "./src/themes.json",
        labels: { forest: "Forest", sunset: "Sunset" },
      },
    }),
    flagsAdapter({
      Provider: FlagsProvider,
      source: import.meta.glob("./src/flags/*.json", {
        eager: true,
        import: "default",
      }),
      sourcePath: "./src/flags/tenants.json",
      flags: {
        newCheckout: { label: "New checkout", control: "toggle" },
        density: {
          label: "Density",
          control: "select",
          options: ["comfortable", "compact"],
        },
      },
    }),
  ],

  i18n: {
    resources: import.meta.glob("./locales/*/app.json", {
      eager: true,
      import: "default",
    }),
    languages: [
      { id: "en-US", label: "EN" },
      { id: "fr-FR", label: "FR" },
      { id: "es-419", label: "ES" },
    ],
    defaultLocale: "en-US",
    defaultNamespace: "app",
    localePath: "./locales/{locale}/{namespace}.json",
  },
});
