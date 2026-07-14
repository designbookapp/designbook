/**
 * UI-side integration registry (S3): resolves the enabled integrations' ui
 * halves into the tab list the workbench left rail renders.
 *
 * Built-ins (see builtins.ts) are default-ON; `integrations: { <name>: false }`
 * in the designbook config opts one out, and an object value carries the
 * integration's options (read back via `getIntegrationOptions`). External
 * package discovery is S6 — the registry is name-keyed so it can land without
 * reshaping this module.
 */

import type { ComponentType } from "react";
import type {
  IntegrationConfigValue,
  PluginScreenProps,
  PluginUiSpec,
} from "../../integration/index.ts";
import { config } from "@designbook-ui/designbook";
import {
  registerSelectionContributor,
  unregisterSelectionContributor,
} from "@designbook-ui/models/selectionContext/registry";
import {
  registerPropsPanelSection,
  unregisterPropsPanelSection,
} from "@designbook-ui/models/propsPanel/sectionRegistry";
import { builtinUiIntegrations } from "./builtins";

/** The ui half of an integration as registered (lazy). */
type UiIntegration = {
  name: string;
  ui: () => Promise<PluginUiSpec>;
};

/** A resolved left-rail tab contributed by an integration. */
type IntegrationTab = {
  /** Rail tab id — the integration name (stable across the plugin refactor
   * so persisted `activeTab` state keeps resolving). */
  id: string;
  label: string;
  Icon?: ComponentType;
  Screen: ComponentType<PluginScreenProps>;
};

let loaded: Array<{ name: string; spec: PluginUiSpec }> = [];
let tabs: IntegrationTab[] = [];
/** Selection-context contributor ids this registry registered (for reset). */
let selectionContributorIds: string[] = [];
/** Props-panel section ids this registry registered (for reset). */
let propsSectionIds: string[] = [];

function configuredValue(name: string): IntegrationConfigValue | undefined {
  const integrations = config.integrations as
    | Record<string, IntegrationConfigValue>
    | undefined;
  return integrations?.[name];
}

/**
 * The options object configured for an integration (`integrations: { <name>:
 * {...} }`), or undefined for default-ON/boolean entries.
 */
function getIntegrationOptions(
  name: string,
): Record<string, unknown> | undefined {
  const value = configuredValue(name);
  return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * Load the enabled integrations' ui halves. Called once by `mountWorkbench`
 * before the workbench renders (alongside the adapter runtime).
 */
async function initUiIntegrations(): Promise<void> {
  const enabled = builtinUiIntegrations.filter(
    (integration) => configuredValue(integration.name) !== false,
  );
  loaded = await Promise.all(
    enabled.map(async (integration) => ({
      name: integration.name,
      spec: await integration.ui(),
    })),
  );
  tabs = loaded.flatMap(({ name, spec }) =>
    spec.tab
      ? [
          {
            id: name,
            label: spec.tab.label,
            Icon: spec.tab.icon,
            Screen: spec.tab.Screen,
          },
        ]
      : [],
  );

  // Selection-context contributions (PREVIEW): the public contributor takes
  // `(sel, { apiUrl })`; adapt it onto the internal runner input.
  for (const { name, spec } of loaded) {
    const contributor = spec.selectionContext;
    if (!contributor) continue;
    registerSelectionContributor(name, (input, ctx) =>
      contributor(input.node, { apiUrl: ctx.apiUrl }),
    );
    selectionContributorIds.push(name);
  }

  // Props-panel sections (PREVIEW): a plugin appends collapsible sections to
  // the end of the props panel — namespaced under the integration so ids never
  // collide across plugins.
  for (const { name, spec } of loaded) {
    for (const section of spec.propsSections ?? []) {
      const id = `${name}:${section.id}`;
      registerPropsPanelSection({ ...section, id });
      propsSectionIds.push(id);
    }
  }
}

/** The resolved integration tabs (empty before initUiIntegrations). */
function getIntegrationTabs(): IntegrationTab[] {
  return tabs;
}

/** Test seam. */
function resetUiIntegrations(): void {
  loaded = [];
  tabs = [];
  for (const id of selectionContributorIds) unregisterSelectionContributor(id);
  selectionContributorIds = [];
  for (const id of propsSectionIds) unregisterPropsPanelSection(id);
  propsSectionIds = [];
}

export {
  getIntegrationOptions,
  getIntegrationTabs,
  initUiIntegrations,
  resetUiIntegrations,
};
export type { IntegrationTab, UiIntegration };
