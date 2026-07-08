/**
 * Workbench tab layout (RHS panel re-org): the left side rail hosts the
 * catalog-ish tabs (files / changes / figma + adapter tabs); the right-hand
 * panel hosts the selection-centric ones (chat / props / code) as horizontal
 * tabs. This module owns the pure id-level split plus the persisted-state
 * migration so both are unit-testable without React.
 */

/** The fixed tab set of the right-hand panel (horizontal tabs). */
const RIGHT_PANEL_TABS = ["chat", "props", "code"] as const;

type RightPanelTab = (typeof RIGHT_PANEL_TABS)[number];

function isRightPanelTab(value: unknown): value is RightPanelTab {
  return (RIGHT_PANEL_TABS as readonly unknown[]).includes(value);
}

/**
 * Resolve the initial left/right tab selection from persisted state.
 *
 * Migration: blobs written before the RHS panel existed persisted `chat` /
 * `code` as the LEFT `activeTab`. Those ids now live on the right, so a
 * right-side id found in `activeTab` seeds the right panel (unless a proper
 * `rightTab` was persisted) and the left falls back to `files`.
 */
function resolveInitialTabs(
  activeTab: string | null,
  rightTab: string | null,
): { left: string; right: RightPanelTab } {
  const right = isRightPanelTab(rightTab)
    ? rightTab
    : isRightPanelTab(activeTab)
      ? activeTab
      : "chat";
  const left = activeTab && !isRightPanelTab(activeTab) ? activeTab : "files";
  return { left, right };
}

export { RIGHT_PANEL_TABS, isRightPanelTab, resolveInitialTabs };
export type { RightPanelTab };
