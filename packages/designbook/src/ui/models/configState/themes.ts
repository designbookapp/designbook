/**
 * Canvas theming from the config's theme options. A theme's CSS custom
 * properties are injected scoped to the canvas container
 * (`.designbook-theme`), so only the preview area re-themes — the workbench
 * chrome keeps its own look. Custom properties set on the container override
 * the app's `:root` defaults for everything rendered inside it.
 */

import { useEffect } from "react";
import { themes } from "@designbook-ui/designbook";
import type { ThemeOption } from "@designbookapp/designbook/config";
import { CANVAS_THEME_CLASS } from "@designbook-ui/models/configState/themeConstants";

const STYLE_ELEMENT_ID = "designbook-theme-style";

const themeOptions: ThemeOption[] = themes;

function cssBlock(selector: string, variables: Record<string, string>): string {
  const declarations = Object.entries(variables)
    .filter(([name]) => name.startsWith("--"))
    .map(([name, value]) => `${name}: ${value};`)
    .join("\n");
  return `${selector} {\n${declarations}\n}`;
}

function buildThemeCss(themeId: string): string | undefined {
  const option = themeOptions.find((candidate) => candidate.id === themeId);
  if (!option?.cssVars) return undefined;

  return [
    cssBlock(`.${CANVAS_THEME_CLASS}`, option.cssVars.root ?? {}),
    cssBlock(`.${CANVAS_THEME_CLASS}.dark`, option.cssVars.dark ?? {}),
  ].join("\n\n");
}

/** Injects the theme's variables as canvas-scoped CSS, swapping it on change. */
function useCanvasTheme(themeId: string) {
  useEffect(() => {
    const css = buildThemeCss(themeId);

    let styleEl = document.getElementById(STYLE_ELEMENT_ID);
    if (css === undefined) {
      styleEl?.remove();
      return;
    }
    if (!(styleEl instanceof HTMLStyleElement)) {
      styleEl = document.createElement("style");
      styleEl.id = STYLE_ELEMENT_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
  }, [themeId]);
}

export { CANVAS_THEME_CLASS, themeOptions, useCanvasTheme };
