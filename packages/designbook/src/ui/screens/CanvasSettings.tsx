import {
  MonitorIcon,
  MoonIcon,
  SmartphoneIcon,
  SunIcon,
  TabletIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@designbook-ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@designbook-ui/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@designbook-ui/components/ui/toggle-group";
import type { ContextDimension } from "@designbookapp/designbook/config";
import { FOLLOW_APP } from "@designbook-ui/hostContext";
import { useConfigStateModel } from "@designbook-ui/models/configState/ConfigStateProvider";
import type { ViewportSize } from "@designbook-ui/models/catalog/viewports";
import { useCatalogModel } from "@designbook-ui/models/catalog/CatalogProvider";

const copy = {
  darkTheme: "Switch to dark theme",
  lightTheme: "Switch to light theme",
  settingsLabel: "Preview settings",
  themeLabel: "Theme",
  viewportLabel: "Viewport size",
};

const viewportIcons: Record<string, ComponentType> = {
  desktop: MonitorIcon,
  tablet: TabletIcon,
  mobile: SmartphoneIcon,
};

/** Human label for a value from a dimension's options, falling back to the raw value. */
function optionLabel(dimension: ContextDimension, value: string | undefined): string {
  if (value === undefined) return "";
  return dimension.options.find((o) => o.value === value)?.label ?? value;
}

function CanvasSettingsBar() {
  const {
    themeId: theme,
    themeOptions,
    dimensions,
    context,
    follow,
    darkMode,
    hideDarkToggle,
    hideThemePreset,
    setTheme: onThemeChange,
    setContext: onDimensionChange,
    toggleDarkMode: onToggleDarkMode,
  } = useConfigStateModel();
  return (
    <div
      role="toolbar"
      aria-label={copy.settingsLabel}
      className="absolute top-3 left-3 z-10 flex items-center gap-1 rounded-full border bg-background px-2 py-1.5 shadow-lg"
    >
      {!hideThemePreset && themeOptions.length > 0 ? (
        <Select value={theme} onValueChange={onThemeChange}>
          <SelectTrigger
            size="sm"
            aria-label={copy.themeLabel}
            className="rounded-full border-0 shadow-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {themeOptions.map((themeOption) => (
              <SelectItem key={themeOption.id} value={themeOption.id}>
                {themeOption.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {dimensions.map((dimension) => {
        const followState = follow?.[dimension.id];
        const following = Boolean(followState?.following);
        // A host-context dimension selects the "App" sentinel while following;
        // otherwise its explicit pick (or the effective/default value).
        const value = following
          ? FOLLOW_APP
          : (context[dimension.id] ?? dimension.defaultValue);
        return (
          <Select
            key={dimension.id}
            value={value}
            onValueChange={(next) => onDimensionChange(dimension.id, next)}
          >
            <SelectTrigger
              size="sm"
              aria-label={dimension.label}
              className="rounded-full border-0 shadow-none"
            >
              {following ? (
                <span className="flex items-center gap-1.5">
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                    App
                  </span>
                  <span>{optionLabel(dimension, followState?.appValue)}</span>
                </span>
              ) : (
                <SelectValue />
              )}
            </SelectTrigger>
            <SelectContent>
              {followState ? (
                <SelectItem value={FOLLOW_APP}>
                  {followState.appValue
                    ? `App · ${optionLabel(dimension, followState.appValue)}`
                    : "Follow app"}
                </SelectItem>
              ) : null}
              {dimension.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      })}
      {hideDarkToggle ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={darkMode ? copy.lightTheme : copy.darkTheme}
          title={darkMode ? copy.lightTheme : copy.darkTheme}
          onClick={onToggleDarkMode}
          className="rounded-full"
        >
          {darkMode ? <SunIcon /> : <MoonIcon />}
        </Button>
      )}
    </div>
  );
}

function ViewportPicker({
  onViewportChange,
  viewport,
}: {
  onViewportChange: (viewport: ViewportSize) => void;
  viewport: ViewportSize;
}) {
  const { viewports } = useCatalogModel();
  return (
    <div
      role="toolbar"
      aria-label={copy.viewportLabel}
      className="absolute top-3 right-3 z-10 flex items-center rounded-full border bg-background px-2 py-1.5 shadow-lg"
    >
      <ToggleGroup
        type="single"
        value={viewport.id}
        onValueChange={(value) => {
          const next = viewports.find((size) => size.id === value);
          if (next) onViewportChange(next);
        }}
        spacing={1}
      >
        {viewports.map((size) => {
          const Icon = viewportIcons[size.id];
          return (
            <ToggleGroupItem
              key={size.id}
              value={size.id}
              size="sm"
              aria-label={size.label}
              title={size.label}
              className="rounded-full"
            >
              {Icon ? <Icon /> : size.label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </div>
  );
}

export { CanvasSettingsBar, ViewportPicker };
