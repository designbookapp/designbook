import { defineConfig } from "@designbookapp/designbook/config";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { Island } from "./packages/excalidraw/components/Island";
import { Card } from "./packages/excalidraw/components/Card";
import { FilledButton } from "./packages/excalidraw/components/FilledButton";
import { ButtonIcon } from "./packages/excalidraw/components/ButtonIcon";
import { Avatar } from "./packages/excalidraw/components/Avatar";
import { TopPicks } from "./packages/excalidraw/components/ColorPicker/TopPicks";
import {
  PlusIcon,
  ExportIcon,
  TrashIcon,
  DuplicateIcon,
} from "./packages/excalidraw/components/icons";

// Round-2 (meatier) components: DarkModeToggle pulls the big App.tsx module
// graph via ToolButton (useExcalidrawContainer) plus excalidraw's custom i18n
// t(); ShadeList/ColorInput use isolated jotai atoms (editor-jotai via
// jotai-scope), which need EditorJotaiProvider — wired via the set wrapper.
import { DarkModeToggle } from "./packages/excalidraw/components/DarkModeToggle";
import { ShadeList } from "./packages/excalidraw/components/ColorPicker/ShadeList";
import { ColorInput } from "./packages/excalidraw/components/ColorPicker/ColorInput";
import { EditorJotaiProvider } from "./packages/excalidraw/editor-jotai";
import { COLOR_PALETTE } from "@excalidraw/common";
import type { Theme } from "@excalidraw/element/types";
import { t } from "./packages/excalidraw/i18n";
import { excalidrawI18nAdapter, getI18nVersion, localeHostSource, subscribeI18n } from "./designbook.text.excalidraw";

// Global CSS excalidraw's own entry (packages/excalidraw/index.tsx) pulls in
// for everyone downstream — CSS custom properties (--color-*, --icon-*, ...)
// plus base resets. We import it directly here (side-effect only) instead of
// going through the package's index.tsx, since that module also drags in the
// full <App> canvas component tree. ColorPicker.scss is imported separately
// because TopPicks (unlike most components here) does not import its own
// stylesheet — its classes live in the shared ColorPicker.scss.
import "./packages/excalidraw/css/app.scss";
import "./packages/excalidraw/css/styles.scss";
import "./packages/excalidraw/components/ColorPicker/ColorPicker.scss";

// excalidraw scopes all of its theme CSS custom properties (--color-*,
// --island-bg-color, ...) under the `.excalidraw` class (see
// packages/excalidraw/css/theme.scss) — the same class App.tsx puts on its
// root container (`excalidraw excalidraw-container notranslate`). Without
// it every component here renders with the vars falling back to browser
// defaults (pale/unstyled). Reproducing that root class on the set wrapper
// is what makes Island/Card/buttons/etc. pick up real excalidraw theming.
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <div
      className="excalidraw excalidraw-container notranslate"
      style={{
        background: "var(--island-bg-color, #fff)",
        padding: 24,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

const IslandDemo = () => (
  <Island padding={2}>
    <div
      style={{
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 160,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13 }}>Shape properties</div>
      <div style={{ display: "flex", gap: 4 }}>
        <ButtonIcon icon={DuplicateIcon} title="Duplicate" onClick={() => {}} standalone />
        <ButtonIcon icon={ExportIcon} title="Export" onClick={() => {}} standalone />
        <ButtonIcon icon={TrashIcon} title="Delete" onClick={() => {}} standalone />
      </div>
    </div>
  </Island>
);

// Mirrors the real usage in JSONExportDialog.tsx (icon + h2 + details +
// button), the only place Card is used in the app — a bare children div
// skips the styled .Card-icon/.Card-details/.Card-button slots entirely.
/** Re-render on adapter saves so t() re-reads the mutated language data. */
const useI18nVersion = () => useSyncExternalStore(subscribeI18n, getI18nVersion);

const CardDemo = () => {
  useI18nVersion();
  return (
    <Card color="primary">
      <div className="Card-icon">{ExportIcon}</div>
      <h2>{t("exportDialog.disk_title")}</h2>
      <div className="Card-details">{t("exportDialog.disk_details")}</div>
      <FilledButton
        className="Card-button"
        label={t("exportDialog.disk_button")}
        onClick={() => {}}
      />
    </Card>
  );
};

const FilledButtonDemo = () => (
  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
    <FilledButton label="Save" color="primary" onClick={() => {}} />
    <FilledButton
      label="Delete"
      color="danger"
      variant="outlined"
      onClick={() => {}}
    />
    <FilledButton
      label="Export"
      icon={ExportIcon}
      variant="icon"
      onClick={() => {}}
    />
  </div>
);

const ButtonIconDemo = () => (
  <div style={{ display: "flex", gap: 4 }}>
    <ButtonIcon icon={PlusIcon} title="Add" onClick={() => {}} standalone />
    <ButtonIcon
      icon={TrashIcon}
      title="Delete"
      onClick={() => {}}
      standalone
    />
  </div>
);

const AvatarDemo = () => (
  <div style={{ display: "flex", gap: 8 }}>
    <Avatar color="#6965db" name="Ada Lovelace" onClick={() => {}} />
    <Avatar color="#e64980" name="Grace Hopper" onClick={() => {}} />
    <Avatar color="#2f9e44" name="Alan Turing" onClick={() => {}} />
  </div>
);

const TopPicksDemo = () => (
  <TopPicks
    type="elementBackground"
    activeColor="#ffc9c9"
    onChange={() => {}}
  />
);

// Editor-level components need the isolated jotai store provider.
function EditorWrapper({ children }: { children: ReactNode }) {
  return (
    <EditorJotaiProvider>
      <div
        className="excalidraw excalidraw-container notranslate"
        style={{ background: "var(--island-bg-color, #fff)", padding: 24 }}
      >
        {children}
      </div>
    </EditorJotaiProvider>
  );
}

const DarkModeToggleDemo = () => {
  const [theme, setTheme] = useState<Theme>("light");
  return <DarkModeToggle value={theme} onChange={setTheme} />;
};

// DarkModeToggle's own string ("Dark mode"/"Light mode") is real excalidraw
// i18n via `t()`, but it only ever reaches the DOM as a `title`/`aria-label`
// HTML attribute (ToolButton renders no visible text, just an SVG icon) — the
// canvas text tool hit-tests actual DOM Text nodes only (buildHit in
// TextToolOverlay.tsx reads `target.childNodes`/`textContent`), so that
// string is unreachable by the text tool no matter what adapter is wired up.
// This wrapper renders the SAME real `t()` calls as visible text nodes so the
// text tool has something to actually click — same source of truth
// (locales/en.json), just exposed as text instead of a tooltip attribute.
const I18nLabelsDemo = () => {
  useI18nVersion();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 14 }}>
      <div>{t("buttons.lightMode")}</div>
      <div>{t("labels.delete")}</div>
      <div>{t("labels.duplicateSelection")}</div>
    </div>
  );
};

const ShadeListDemo = () => {
  const [color, setColor] = useState<string>(COLOR_PALETTE.red[1]);
  return <ShadeList color={color} onChange={setColor} palette={COLOR_PALETTE} />;
};

const ColorInputDemo = () => {
  const [color, setColor] = useState("#e64980");
  return (
    <ColorInput
      color={color}
      onChange={setColor}
      label="Stroke color"
      colorPickerType="elementStroke"
    />
  );
};

export default defineConfig({
  title: "excalidraw (compat spike — agent A)",

  // Maps registered components to repo files so the code panel shows source.
  sourceModules: import.meta.glob(
    [
      "./packages/excalidraw/components/{Island,Card,FilledButton,ButtonIcon,Avatar,DarkModeToggle}.tsx",
      "./packages/excalidraw/components/ColorPicker/{TopPicks,ShadeList,ColorInput}.tsx",
    ],
    { eager: true },
  ),

  adapters: [excalidrawI18nAdapter],

  // C4.3: the `locale` dimension follows excalidraw's live language in injected
  // mode until the designer picks one in the workbench.
  hostContext: {
    locale: localeHostSource,
  },

  sets: [
    {
      id: "primitives",
      title: "Excalidraw/Primitives",
      wrapper: Wrapper,
      components: {
        Island: IslandDemo,
        Card: CardDemo,
        FilledButton: FilledButtonDemo,
        ButtonIcon: ButtonIconDemo,
        Avatar: AvatarDemo,
        TopPicks: TopPicksDemo,
        I18nLabels: I18nLabelsDemo,
      },
      // Demo wrappers live in this file; point the code panel at the real sources.
      overrides: {
        Island: { sourcePath: "packages/excalidraw/components/Island.tsx" },
        Card: { sourcePath: "packages/excalidraw/components/Card.tsx" },
        FilledButton: { sourcePath: "packages/excalidraw/components/FilledButton.tsx" },
        ButtonIcon: { sourcePath: "packages/excalidraw/components/ButtonIcon.tsx" },
        Avatar: { sourcePath: "packages/excalidraw/components/Avatar.tsx" },
        TopPicks: { sourcePath: "packages/excalidraw/components/ColorPicker/TopPicks.tsx" },
        I18nLabels: { sourcePath: "packages/excalidraw/i18n.ts" },
      },
    },
    {
      id: "editor",
      title: "Excalidraw/Editor",
      wrapper: EditorWrapper,
      components: {
        DarkModeToggle: DarkModeToggleDemo,
        ShadeList: ShadeListDemo,
        ColorInput: ColorInputDemo,
      },
      overrides: {
        DarkModeToggle: { sourcePath: "packages/excalidraw/components/DarkModeToggle.tsx" },
        ShadeList: { sourcePath: "packages/excalidraw/components/ColorPicker/ShadeList.tsx" },
        ColorInput: { sourcePath: "packages/excalidraw/components/ColorPicker/ColorInput.tsx" },
      },
    },
  ],
});
