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
  // Props panel: a JSX-attribute write at a component's usage site (direct-
  // edits changeset when a conversation is active, else the real file).
  "POST /api/props-edit",
  "POST /api/changes/discard",
  // Design variations (docs/specs/design-variations.md): generation and
  // resolution both write repo files (variant files / promoted components).
  "POST /api/variations/generate",
  "POST /api/variations/iterate",
  "POST /api/variations/retry",
  "POST /api/variations/resolve",
  // Sandbox (docs/specs/sandbox.md): pins write the durable index; prompt/
  // iterate/replace run write-capable agent turns; position rewrites the index.
  "POST /api/sandbox/pin",
  "POST /api/sandbox/prompt",
  // UX v3 single entry: routes to the same write-capable pipelines.
  "POST /api/sandbox/ask",
  "POST /api/sandbox/iterate",
  "POST /api/sandbox/retry",
  // Render-failure reports trigger a write-capable auto-fix agent turn.
  "POST /api/sandbox/render-failure",
  "POST /api/sandbox/replace",
  // Crash reports append a warning to the pin thread (durable index write).
  "POST /api/sandbox/replace-crash",
  "POST /api/sandbox/position",
  // Switch flips rewrite layer metas + merged artifacts (changeset layers).
  "POST /api/sandbox/switch",
  // Layer activation flips rewrite metas + the redirect table.
  "POST /api/sandbox/activate",
  // Bake writes real source (deterministic copy / 3-way merge; merge-agent
  // turn on conflict); discard deletes the layer dir (changeset layers L1).
  "POST /api/sandbox/bake",
  "POST /api/sandbox/discard",
  // Compose runs a write-capable merge-agent turn + registers a changeset.
  "POST /api/sandbox/compose",
  // Rollback moves hidden refs + rewrites the projected layer cache (G1).
  "POST /api/sandbox/rollback",
  // Reapply cherry-picks commits onto a hidden branch (merge turn on
  // conflict) + rewrites the projected cache (G2).
  "POST /api/sandbox/reapply",
  // Rebase rewrites hidden refs + the projected cache (merge turn on
  // conflict); bake-to-branch creates/advances a REAL branch ref (G3).
  "POST /api/sandbox/rebase",
  "POST /api/sandbox/bake-to-branch",
]);

export { READ_ONLY_BLOCKED_ROUTES };
