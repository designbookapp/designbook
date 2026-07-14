/**
 * Props-panel SECTION REGISTRY (docs/specs/props-panel.md §Plugin sections).
 *
 * Plugins append sections to the END of the props panel — below the core prop
 * controls — the same way they contribute a left-rail tab or a
 * selection-context section: their ui half declares `propsSections` on its
 * `PluginUiSpec`, and `initUiIntegrations` feeds each one here (see
 * ui/integrations/registry.ts). The panel reads `getPropsPanelSections()` and
 * renders them collapsible, in `order` then `id` order. An empty registry
 * renders nothing extra.
 *
 * Kept as a tiny standalone module (not folded into the integrations registry)
 * so the seam is unit-testable on its own and the panel needn't pull the whole
 * integrations graph.
 */

import type { PropsPanelSectionSpec } from "@designbook-ui/integrations";

const sections = new Map<string, PropsPanelSectionSpec>();

/** Register (or replace, by id) one props-panel section. */
function registerPropsPanelSection(section: PropsPanelSectionSpec): void {
  sections.set(section.id, section);
}

/** Drop one section by id (reset seam). */
function unregisterPropsPanelSection(id: string): void {
  sections.delete(id);
}

/** The registered sections, sorted by `order` (default 0) then `id`. */
function getPropsPanelSections(): PropsPanelSectionSpec[] {
  return [...sections.values()].sort((a, b) => {
    const orderDelta = (a.order ?? 0) - (b.order ?? 0);
    return orderDelta !== 0 ? orderDelta : a.id.localeCompare(b.id);
  });
}

/** Clear all sections (mount re-init / tests). */
function resetPropsPanelSections(): void {
  sections.clear();
}

export {
  getPropsPanelSections,
  registerPropsPanelSection,
  resetPropsPanelSections,
  unregisterPropsPanelSection,
};
