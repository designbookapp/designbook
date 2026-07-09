/**
 * Pure session-memory logic for the App page's default tool.
 *
 * The App page (the live-app iframe cell) defaults the SELECT tool ON every
 * time it becomes active — users were confused clicking around the live app
 * with the tool off and nothing happening. The one exception: if the user
 * EXPLICITLY turned select off earlier in this session, respect that until the
 * page is reloaded (session-level memory, never persisted). Kept DOM/React-free
 * so `Workbench` just holds a boolean ref and asks these two questions.
 */

/**
 * Should activating the App page auto-arm the select tool? Yes, unless the user
 * dismissed select during this session.
 */
function shouldArmAppPageSelect(dismissedThisSession: boolean): boolean {
  return !dismissedThisSession;
}

/**
 * The new session-dismissal flag after the user changes the tool while on the
 * App page: dismissed iff they chose a NON-select tool (picking select clears
 * the dismissal so a later re-entry auto-arms again).
 */
function appPageSelectDismissed(nextTool: string): boolean {
  return nextTool !== "select";
}

export { appPageSelectDismissed, shouldArmAppPageSelect };
