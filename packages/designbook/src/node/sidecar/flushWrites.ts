/**
 * Route-matching for the `/__designbook/flush-writes` endpoint.
 *
 * `plugin.ts`'s injected dev-server middleware already polls the sidecar for
 * recently-designbook-written files once a second (`fetchRecentWrites`) and
 * invalidates their Vite module-graph entries so a later reload doesn't serve
 * the stale pre-edit transform (see `hmrSuppress.ts`'s doc comment). That poll
 * is what the App-page frame text tool's reload used to race: a save could
 * land, and the reload fire, before the NEXT tick of the 1s timer ran the
 * invalidation — the frame would show stale text until the timer caught up.
 *
 * This endpoint lets a caller (the frame text tool, right after a save)
 * collapse that race to zero by awaiting ONE poll+invalidate pass on demand,
 * then reloading only once it resolves. The route decision itself is kept
 * pure/unit-testable here; `plugin.ts` wires it to the real poll function
 * (`fetchRecentWrites`) and a real `ServerResponse`.
 */

const FLUSH_WRITES_PATH = "/__designbook/flush-writes";

/** Whether a request matches the flush-writes route (POST only — it triggers
 * a side effect, not an idempotent read). */
function isFlushWritesRequest(
  pathname: string,
  method: string | undefined,
): boolean {
  return (
    pathname === FLUSH_WRITES_PATH && (method ?? "GET").toUpperCase() === "POST"
  );
}

export { FLUSH_WRITES_PATH, isFlushWritesRequest };
