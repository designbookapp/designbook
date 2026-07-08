/**
 * Flow definitions — groups of screens representing end-to-end user journeys.
 * Each flow has a unique id and a Storybook-style `/`-delimited title used to
 * derive folder structure in the Files panel.
 *
 * Flows come from the user's config. When none are configured, one flow per
 * component set is synthesized so the landing canvas still shows everything.
 */

import { config, sets } from "@designbook-ui/designbook";
import { getSetEntries } from "@designbook-ui/models/catalog/componentRegistry";
import type { Flow, FlowScreen } from "@designbook-ui/models/catalog/flowSpec";

function synthesizeFlows(): Flow[] {
  return sets
    .map((set) => ({
      id: set.id,
      title: set.title,
      screens: getSetEntries(set.id).map(
        (entry): FlowScreen => ({
          id: entry.id,
          label: entry.name,
          description: entry.sourcePath,
          registryId: entry.id,
        }),
      ),
    }))
    .filter((flow) => flow.screens.length > 0);
}

const flows: Flow[] = config.flows?.length ? config.flows : synthesizeFlows();

function getFlowById(id: string): Flow | undefined {
  return flows.find((flow) => flow.id === id);
}

/** Find the flow that contains a given screen id. */
function getFlowForScreen(screenId: string): Flow | undefined {
  return flows.find((flow) =>
    flow.screens.some((screen) => screen.id === screenId),
  );
}

/** Search all flows for a screen by id. */
function getFlowScreen(screenId: string): FlowScreen | undefined {
  for (const flow of flows) {
    const screen = flow.screens.find((s) => s.id === screenId);
    if (screen) return screen;
  }
  return undefined;
}

export { flows, getFlowById, getFlowForScreen, getFlowScreen };
export type { Flow, FlowScreen };
