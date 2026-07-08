import { defineConfig, fromGlob } from "@designbookapp/designbook/config";
import { themeAdapter } from "@designbookapp/designbook/adapters";

// Injected-mode fixture: exercises the prebuilt `@designbookapp/designbook/adapters` bundle
// (themeAdapter) sharing ONE runtime with the workbench, and the i18next adapter
// attributing the app's own react-i18next strings (bug-2 proof).
export default defineConfig({
  title: "i18n App",

  sets: [
    {
      id: "components",
      title: "App/Components",
      components: fromGlob(import.meta.glob("./src/components/*.tsx")),
    },
  ],

  adapters: [
    themeAdapter({
      source: "./src/theme.css",
      modes: { light: ":root", dark: ".dark" },
    }),
  ],

  i18n: {
    resources: import.meta.glob("./locales/*/app.json", {
      eager: true,
      import: "default",
    }),
    languages: [
      { id: "en", label: "EN" },
      { id: "fr", label: "FR" },
    ],
    defaultLocale: "en",
    defaultNamespace: "app",
    localePath: "./locales/{locale}/{namespace}.json",
  },
});
