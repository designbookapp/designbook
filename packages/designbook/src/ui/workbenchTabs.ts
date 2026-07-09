/**
 * Workbench tab layout (RHS panel re-org): the left side rail hosts the
 * catalog-ish tabs (files / changes / figma + adapter tabs); the right-hand
 * panel hosts the selection-centric ones (chat / info / code) as horizontal
 * tabs. This module owns the pure id-level split plus the persisted-state
 * migration so both are unit-testable without React.
 */

/** The fixed tab set of the right-hand panel (horizontal tabs, in order). */
const RIGHT_PANEL_TABS = ["chat", "info", "code"] as const;

type RightPanelTab = (typeof RIGHT_PANEL_TABS)[number];

function isRightPanelTab(value: unknown): value is RightPanelTab {
  return (RIGHT_PANEL_TABS as readonly unknown[]).includes(value);
}

/** Renamed right-panel ids: persisted blobs written before the rename. */
const LEGACY_RIGHT_TABS: Record<string, RightPanelTab> = {
  // The Props tab became the Info panel (selection-context registry).
  props: "info",
};

/** A current or legacy right-panel id resolved forward, else undefined. */
function migrateRightTab(value: string | null): RightPanelTab | undefined {
  if (isRightPanelTab(value)) return value;
  return value !== null ? LEGACY_RIGHT_TABS[value] : undefined;
}

/**
 * Resolve the initial left/right tab selection from persisted state.
 *
 * Migrations: blobs written before the RHS panel existed persisted `chat` /
 * `code` as the LEFT `activeTab` — a right-side id found there seeds the
 * right panel (unless a proper `rightTab` was persisted) and the left falls
 * back to `files`. Blobs written before the Props→Info rename persisted
 * `rightTab: "props"`, which resolves to `"info"` so nobody lands on a dead
 * tab.
 */
function resolveInitialTabs(
  activeTab: string | null,
  rightTab: string | null,
): { left: string; right: RightPanelTab } {
  const right = migrateRightTab(rightTab) ?? migrateRightTab(activeTab) ?? "chat";
  const left =
    activeTab && migrateRightTab(activeTab) === undefined ? activeTab : "files";
  return { left, right };
}

export { RIGHT_PANEL_TABS, isRightPanelTab, migrateRightTab, resolveInitialTabs };
export type { RightPanelTab };
