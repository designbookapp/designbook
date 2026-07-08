/**
 * Canonical `configState` model fixtures.
 *
 * ONE hardcoded dimension set — a theme preset, a `mode` (light/dark) dimension
 * and a `locale` dimension (one following the app), a couple of datasets — used
 * by the model's unit tests AND (later) by cells that render the settings bar
 * without a live adapter runtime. `createConfigStateFixture` returns a fresh
 * dataset each call whose setters append to shared logs so a consumer can assert
 * routing.
 */

import type { ConfigStateData } from "./configStateModel";

type ConfigStateFixture = {
  /** Feed straight into `<ConfigStateProvider data={...}>` or the factory. */
  data: ConfigStateData;
  themes: string[];
  contexts: Array<{ id: string; value: string }>;
  datasetSelections: string[];
  darkToggles: number;
  setTheme: (id: string) => void;
  setContext: (id: string, value: string) => void;
  setDataset: (id: string) => void;
  toggleDarkMode: () => void;
};

function createConfigStateFixture(): ConfigStateFixture {
  const themes: string[] = [];
  const contexts: Array<{ id: string; value: string }> = [];
  const datasetSelections: string[] = [];
  const fixture: ConfigStateFixture = {
    data: {
      themeId: "brand",
      themeOptions: [
        { id: "brand", label: "Brand" },
        { id: "neutral", label: "Neutral" },
      ],
      dimensions: [
        {
          id: "theme:mode",
          label: "Mode",
          control: "segmented",
          options: [
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ],
          defaultValue: "light",
        },
        {
          id: "i18n:locale",
          label: "Locale",
          options: [
            { value: "en-US", label: "English" },
            { value: "fr-FR", label: "Français" },
          ],
          defaultValue: "en-US",
        },
      ],
      context: { "theme:mode": "light", "i18n:locale": "en-US" },
      follow: {
        "i18n:locale": { following: true, appValue: "en-US" },
      },
      darkMode: false,
      hideDarkToggle: true,
      hideThemePreset: false,
      datasets: [
        { id: "default", label: "Default", data: {} },
        { id: "empty", label: "Empty", data: {} },
      ],
      datasetId: "default",
    },
    themes,
    contexts,
    datasetSelections,
    darkToggles: 0,
    setTheme: (id) => themes.push(id),
    setContext: (id, value) => contexts.push({ id, value }),
    setDataset: (id) => datasetSelections.push(id),
    toggleDarkMode: () => {
      fixture.darkToggles += 1;
    },
  };
  return fixture;
}

export { createConfigStateFixture };
export type { ConfigStateFixture };
