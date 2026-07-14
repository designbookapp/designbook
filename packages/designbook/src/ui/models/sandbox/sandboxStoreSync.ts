/**
 * The sandbox store's LIFECYCLE, framework-free (SandboxProvider wires it to
 * React state; tests drive it with fakes).
 *
 * G4 regression (the injected-overlay staleness): the shared /api/events
 * stream is RELEASED while a tab stays hidden past the eventBus grace (and
 * on any transport drop). The server replays chat `state` on reconnect, but
 * sandbox-events that fired during the gap are gone forever — the store
 * (pins/changesets/switches, G2 turn rows, reapply strips) stayed stale
 * until a full reload. So this sync RE-SEEDS from GET /api/sandbox on every
 * RECONNECT (every "open" after the first): the status payload is the
 * durable truth for pins/changesets/switches/conflicts/reapply, while the
 * transient SSE-only slices (bake/rebase progress) carry over — their next
 * event re-syncs them.
 */

import {
  applySandboxStoreEvent,
  storeFromStatus,
  type SandboxEvent,
  type SandboxStatusPayload,
  type SandboxStore,
} from "./sandboxModel";

type SandboxStoreSyncDeps = {
  /** GET /api/sandbox (undefined = unreachable/legacy — keep the store). */
  fetchStatus: () => Promise<SandboxStatusPayload | undefined>;
  /** Subscribe to parsed `sandbox-event`s; returns unsubscribe. */
  subscribeEvents: (handler: (event: SandboxEvent) => void) => () => void;
  /** Subscribe to the shared stream's "open"/"error" status. */
  subscribeStatus: (handler: (status: "open" | "error") => void) => () => void;
  /** Push one store update (React setState-style updater). */
  onStore: (update: (current: SandboxStore) => SandboxStore) => void;
  /** Side effects per event (file-write bus nudge, crash watch) — folding
   * stays in here either way. */
  onEvent?: (event: SandboxEvent) => void;
};

/** Start the sync; returns dispose. */
function startSandboxStoreSync(deps: SandboxStoreSyncDeps): () => void {
  let disposed = false;
  let sawOpen = false;

  const seed = (reconnect: boolean) => {
    void deps
      .fetchStatus()
      .then((payload) => {
        if (disposed || !payload) return;
        deps.onStore((current) => ({
          ...storeFromStatus(payload),
          // Transient SSE-only progress slices survive a re-seed — their
          // next `bake-status`/`rebase-status` event re-syncs them.
          ...(reconnect
            ? { bakes: current.bakes, rebases: current.rebases }
            : {}),
        }));
      })
      .catch(() => {
        // No server / legacy server — the feature stays dormant.
      });
  };

  seed(false);
  const unsubscribeEvents = deps.subscribeEvents((event) => {
    if (disposed) return;
    deps.onStore((current) => applySandboxStoreEvent(current, event));
    deps.onEvent?.(event);
  });
  const unsubscribeStatus = deps.subscribeStatus((status) => {
    if (disposed || status !== "open") return;
    // Every open AFTER the first is a reconnect — events may have been
    // missed while the stream was down/released; the payload catches up.
    if (sawOpen) seed(true);
    sawOpen = true;
  });

  return () => {
    disposed = true;
    unsubscribeEvents();
    unsubscribeStatus();
  };
}

export { startSandboxStoreSync };
export type { SandboxStoreSyncDeps };
