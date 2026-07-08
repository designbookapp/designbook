/**
 * Read-only mode's blocked data endpoints (backlog #6): these bypass the agent
 * entirely, so `--read-only` has to be enforced at the route level too, not
 * just via the agent's restricted tool set. Module-scoped (rather than inside
 * `createApi`) so the set is directly assertable by tests.
 */
const READ_ONLY_BLOCKED_ROUTES = new Set([
  "POST /api/file",
  "POST /api/json",
  "POST /api/style",
  "POST /api/i18n",
  "POST /api/po",
  "POST /api/changes/discard",
]);

export { READ_ONLY_BLOCKED_ROUTES };
