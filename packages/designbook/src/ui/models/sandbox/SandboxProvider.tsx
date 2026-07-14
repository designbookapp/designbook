/**
 * Live sandbox state + actions (docs/specs/sandbox.md).
 *
 * Composition-root provider (the VariationsProvider altitude): one
 * GET /api/sandbox on mount (reload reconstruction from the durable index,
 * D4), one EventSource subscription folding `sandbox-event`s through the pure
 * model, and thin action wrappers over the write endpoints.
 *
 * Also owns the TRANSIENT pin-anchor registry: the live DOM element a pin was
 * created from, so the app-frame bubbles can re-resolve its rect per render.
 * Anchors are never persisted (pin identity is the code target); a pin whose
 * anchor is gone/disconnected lives in the bottom-bar tray only.
 *
 * Variant landings ping the file-write bus so the Changes tab refreshes (pin
 * sessions' pi-events are never broadcast, so `agent_end` never fires here).
 *
 * Also the injected crash reporter (element replace safety, E4): a `replaced`
 * event arms a ~20s window listener; the FIRST window error/unhandled
 * rejection posts /api/sandbox/replace-crash — appended to the pin thread as
 * a warning, never blocking the resolve. In page mode this provider runs in
 * the live app's own window; on the App page the proxied iframe app runs its
 * own injected copy hearing the same SSE — both surfaces are covered.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiUrl } from "@designbook-ui/designbook";
import {
  subscribeApiEvents,
  subscribeConnectionStatus,
} from "@designbook-ui/models/events/eventBus";
import { notifyFileWritten } from "@designbook-ui/fileWriteBus";
import { startSandboxStoreSync } from "./sandboxStoreSync";
import {
  applySandboxStoreEvent,
  sandboxEventMatchesBranch,
  type SandboxBakeState,
  type SandboxChangesetState,
  type SandboxDataConflict,
  type SandboxEvent,
  type SandboxFileConflict,
  type SandboxReapplyState,
  type SandboxRebaseState,
  type SandboxState,
  type SandboxStatusPayload,
  type SandboxStore,
  type SandboxSwitchSelection,
  type SandboxSwitchesState,
} from "./sandboxModel";
import type { SandboxElementLocator, SandboxTargetInput } from "./capture";
import type { SandboxIterateElementDescriptor } from "./iterateDescriptor";

type ActionResult = { error?: string };

/** Post-replace crash-report window (mirrors the server constant, E4). */
const REPLACE_CRASH_WINDOW_MS = 20_000;

type SandboxApi = {
  /** All pins keyed by id (resolved ones included — views filter). */
  pins: SandboxState;
  /** O1 changesets (per pin thread) — active ones own the live overrides. */
  changesets: SandboxChangesetState[];
  /** O1 per-component switch state (server-persisted, SSE-synced). */
  switches: SandboxSwitchesState;
  /** O2 transient bake progress per changeset (`bake-status` SSE). */
  bakes: Record<string, SandboxBakeState>;
  /** G3 transient rebase progress per changeset (`rebase-status` SSE). */
  rebases: Record<string, SandboxRebaseState>;
  /** SERVER-computed file-level layer conflicts (changeset layers) — the
   * Changes-panel surfacing; live via `changesets-changed`. */
  conflicts: SandboxFileConflict[];
  /** SERVER-computed data-key merge conflicts (same key, different values). */
  dataConflicts: SandboxDataConflict[];
  /** G2: the live reapply offer/progress after a variant switch (transient;
   * absent = nothing pending). NEVER auto-applied — the strips ask. */
  reapplyState?: SandboxReapplyState;
  /** Accept the reapply offer: cherry-pick the old branch's post-selection
   * edits onto the (newly) selected branch (POST /api/sandbox/reapply). */
  reapply: (params: {
    changesetId: string;
    fromRef: string;
    toRef?: string;
  }) => Promise<ActionResult>;
  /** Decline/clear the offer — nothing happens, the edits stay put (spec). */
  dismissReapply: () => void;
  /** G4 PARK: preview a mid-history commit/turn non-destructively (POST
   * /api/sandbox/park). No ref moves; new work while parked forks. */
  park: (params: {
    changesetId: string;
    commit?: string;
    turn?: string;
  }) => Promise<ActionResult>;
  /** G4: exit the history preview — back to the selected tips. */
  exitPark: (params: { changesetId: string }) => Promise<ActionResult>;
  /** Flip a component's switch (null selection = original). */
  setSwitch: (params: {
    component: string;
    selection: SandboxSwitchSelection | null;
  }) => Promise<ActionResult>;
  /** Bake a changeset into real source (O2 — queued server-side; progress
   * streams as `bake-status`). `force` confirms a DRIFTED changeset. */
  bake: (params: {
    changesetId: string;
    force?: boolean;
  }) => Promise<ActionResult>;
  /** Discard a changeset: the LAYER (alternatives + data additions) is
   * dropped whole; the pin thread stays as history. */
  discard: (params: { changesetId: string }) => Promise<ActionResult>;
  /** G3: rebase a DRIFTED changeset's branches onto the current source
   * (merge turn only on conflict; abort restores everything). */
  rebase: (params: { changesetId: string }) => Promise<ActionResult>;
  /** G3 bake-to-branch (B1): materialize the changeset onto a REAL visible
   * branch (default name designbook/<slug>); the changeset stays active. */
  bakeToBranch: (params: {
    changesetId: string;
    name?: string;
    skipGate?: boolean;
    force?: boolean;
  }) => Promise<ActionResult & { branch?: string }>;
  /** Activate/deactivate a whole changeset layer (changeset layers L1) —
   * the file-level conflict "choose" action (deactivate one). */
  activate: (params: {
    changesetId: string;
    active: boolean;
  }) => Promise<ActionResult>;
  /** Compose two active changesets over one export (O3): one merge-agent
   * turn → a NEW changeset based on both; progress streams as events. */
  compose: (params: {
    component: string;
    changesetIds?: string[];
  }) => Promise<ActionResult & { id?: string }>;
  createPin: (params: {
    target: SandboxTargetInput;
    contextSnapshot: unknown;
    /** Element pins (docs/specs/sandbox.md v2) — absent = component. */
    kind?: "component" | "element";
    locator?: SandboxElementLocator;
    /** Source-resolved owners (unregistered authoring component): the
     * named-owner chain the server resolves `target.file` from when the
     * client could not (sourceOwner.ts). */
    ownerNames?: string[];
  }) => Promise<ActionResult & { id?: string }>;
  prompt: (params: {
    pinId: string;
    prompt: string;
    mode: "edit" | "variants";
    n?: number;
  }) => Promise<ActionResult>;
  /** UX v3 single entry (U3): the server classifies variants-vs-turn from
   * the prompt and routes — no mode from the client. */
  ask: (params: { pinId: string; prompt: string }) => Promise<ActionResult>;
  iterate: (params: {
    pinId: string;
    variantId: string;
    prompt: string;
    /** Canvas element selection: the selected element INSIDE this variant's
     * rendered preview — the server folds it into the iterate prompt. */
    element?: SandboxIterateElementDescriptor;
  }) => Promise<ActionResult>;
  /** Re-run ONE failed variant (fresh turn, same direction + request). */
  retry: (params: {
    pinId: string;
    variantId: string;
  }) => Promise<ActionResult>;
  /** Report a READY variant that crashed / rendered empty on the canvas —
   * the server marks it failed and auto-fixes once (render-verify loop). */
  renderFailure: (params: {
    pinId: string;
    variantId: string;
    error: string;
  }) => Promise<ActionResult>;
  replace: (params: {
    pinId: string;
    variantId: string;
  }) => Promise<ActionResult>;
  position: (params: {
    pinId: string;
    variantId: string;
    x: number;
    y: number;
    /** A number sets an explicit frame size (overrides auto), `null` resets to
     * auto-size, absent leaves the current size (a plain move). */
    w?: number | null;
    h?: number | null;
  }) => Promise<ActionResult>;
  /** Transient live anchor for bubble re-resolution (never persisted). */
  registerPinAnchor: (pinId: string, anchor: Element | undefined) => void;
  getPinAnchor: (pinId: string) => Element | undefined;
};

const SandboxContext = createContext<SandboxApi | undefined>(undefined);

async function post<T extends ActionResult>(
  path: string,
  body: unknown,
): Promise<T> {
  try {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as T;
    if (!response.ok) {
      return { error: payload.error ?? "The request failed." } as T;
    }
    return payload;
  } catch {
    return { error: "The design server is unreachable." } as T;
  }
}

/**
 * Post-replace crash watches must SURVIVE the vite full reload a replace
 * causes (the replace edits real source + the durable index — live-probe
 * finding: the reload destroyed an in-memory watch before the new code even
 * ran). The armed window is persisted per pin in sessionStorage (same tab
 * across reloads) and re-armed on provider mount.
 */
const CRASH_WATCH_STORE = "designbook:sandbox:replace-crash-watch";

/** pinId → epoch-ms deadline of its armed watch. Storage errors = {}. */
function readStoredCrashWatches(): Record<string, number> {
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(CRASH_WATCH_STORE) ?? "{}",
    ) as Record<string, number>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredCrashWatches(watches: Record<string, number>): void {
  try {
    const live = Object.fromEntries(
      Object.entries(watches).filter(([, until]) => until > Date.now()),
    );
    if (Object.keys(live).length === 0) {
      window.sessionStorage.removeItem(CRASH_WATCH_STORE);
    } else {
      window.sessionStorage.setItem(CRASH_WATCH_STORE, JSON.stringify(live));
    }
  } catch {
    // Storage unavailable — the watch degrades to this load only.
  }
}

/**
 * Arm the post-replace crash watch until `until` (epoch ms): the FIRST window
 * error / unhandled rejection before the deadline reports to
 * /api/sandbox/replace-crash (warning only — resolve already landed).
 * Returns the disarm function.
 */
function armReplaceCrashWatch(pinId: string, until: number): () => void {
  const remaining = until - Date.now();
  if (remaining <= 0) return () => {};
  let reported = false;
  function report(error: unknown) {
    if (reported) return;
    reported = true;
    disarm();
    // Reported — this watch is DONE across reloads too.
    const stored = readStoredCrashWatches();
    delete stored[pinId];
    writeStoredCrashWatches(stored);
    void post("/api/sandbox/replace-crash", {
      pinId,
      error:
        error instanceof Error
          ? error.message
          : String(error ?? "window error"),
    });
  }
  function onError(event: ErrorEvent) {
    report(event.error ?? event.message);
  }
  function onRejection(event: PromiseRejectionEvent) {
    report(event.reason);
  }
  const timer = window.setTimeout(disarm, remaining);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  // NOTE: disarm must NOT clear the persisted deadline — provider remounts
  // (StrictMode double-mount, page-tools re-open, the post-replace reload
  // itself) disarm and re-arm from storage; only report() or natural expiry
  // (pruned on the next storage write) retires the entry.
  function disarm() {
    window.clearTimeout(timer);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  }
  return disarm;
}

function SandboxProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<SandboxStore>({
    pins: {},
    changesets: [],
    switches: {},
    bakes: {},
    rebases: {},
    conflicts: [],
    dataConflicts: [],
  });
  const anchorsRef = useRef(new Map<string, Element>());
  /** Active post-replace crash watches, keyed by pin (disarm on re-arm). */
  const crashWatchesRef = useRef(new Map<string, () => void>());
  // Branch-session scoping (per-branch-sessions spec): this page's session
  // branch, from the chat `state` events (undefined until the first one =
  // primary — the DesignChat convention). Sandbox events from OTHER
  // branches' homes are dropped, mirroring the pi-event rule: they describe
  // a different repo root's pins/changesets and must not fold here.
  const viewedBranchRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const unsubscribeState = subscribeApiEvents("state", (messageEvent) => {
      try {
        const state = JSON.parse(messageEvent.data as string) as {
          branch?: unknown;
        };
        viewedBranchRef.current =
          typeof state.branch === "string" && state.branch
            ? state.branch
            : undefined;
      } catch {
        // Malformed state — keep the current scope.
      }
    });
    return unsubscribeState;
  }, []);

  useEffect(() => {
    // Store lifecycle (seed fetch + event folds + RECONNECT re-seed — the
    // G4 injected-overlay staleness fix) lives in sandboxStoreSync.ts;
    // this effect only wires it to React state + the DOM side effects.
    const dispose = startSandboxStoreSync({
      fetchStatus: () =>
        fetch(apiUrl("/api/sandbox")).then(
          (response) => response.json() as Promise<SandboxStatusPayload>,
        ),
      subscribeEvents: (handler) =>
        subscribeApiEvents("sandbox-event", (messageEvent) => {
          let event: SandboxEvent;
          try {
            event = JSON.parse(messageEvent.data as string) as SandboxEvent;
          } catch {
            return; // Ignore malformed events.
          }
          // Another branch's home — not this page's store (see
          // sandboxEventMatchesBranch).
          if (!sandboxEventMatchesBranch(event, viewedBranchRef.current)) {
            return;
          }
          handler(event);
        }),
      subscribeStatus: subscribeConnectionStatus,
      onStore: setStore,
      onEvent: (event) => {
        // Sandbox files changed on disk — nudge the Changes tab.
        if (
          event.type === "variant-ready" ||
          event.type === "variant-updated" ||
          event.type === "replaced"
        ) {
          notifyFileWritten(event.file);
        }
        // A replace landed in the REAL source: watch this window ~20s for a
        // crash the new code causes and report it (warning only, E4). The
        // deadline is persisted so the watch survives the vite full reload
        // the replace itself triggers.
        if (event.type === "replaced" && event.pinId) {
          const until = Date.now() + REPLACE_CRASH_WINDOW_MS;
          writeStoredCrashWatches({
            ...readStoredCrashWatches(),
            [event.pinId]: until,
          });
          crashWatchesRef.current.get(event.pinId)?.();
          crashWatchesRef.current.set(
            event.pinId,
            armReplaceCrashWatch(event.pinId, until),
          );
        }
      },
    });
    // Re-arm watches that were live before a reload (post-replace HMR).
    const watches = crashWatchesRef.current;
    for (const [pinId, until] of Object.entries(readStoredCrashWatches())) {
      if (until > Date.now() && !watches.has(pinId)) {
        watches.set(pinId, armReplaceCrashWatch(pinId, until));
      }
    }
    return () => {
      dispose();
      for (const disarm of watches.values()) disarm();
      watches.clear();
    };
  }, []);

  const api: SandboxApi = {
    pins: store.pins,
    changesets: store.changesets,
    switches: store.switches,
    bakes: store.bakes,
    rebases: store.rebases,
    conflicts: store.conflicts,
    dataConflicts: store.dataConflicts,
    ...(store.reapply ? { reapplyState: store.reapply } : {}),
    reapply: (params) => post("/api/sandbox/reapply", params),
    // Decline: clear locally AND drop the server-held offer (so a reload
    // doesn't resurface it) — the branches themselves are never touched.
    dismissReapply: () => {
      const offer = store.reapply;
      setStore((current) =>
        applySandboxStoreEvent(current, { type: "reapply-dismissed" }),
      );
      if (offer) {
        void post("/api/sandbox/reapply", {
          changesetId: offer.changesetId,
          dismiss: true,
        });
      }
    },
    park: (params) => post("/api/sandbox/park", params),
    exitPark: (params) =>
      post("/api/sandbox/park", { changesetId: params.changesetId, commit: null }),
    setSwitch: (params) => post("/api/sandbox/switch", params),
    bake: (params) => post("/api/sandbox/bake", params),
    discard: (params) => post("/api/sandbox/discard", params),
    rebase: (params) => post("/api/sandbox/rebase", params),
    bakeToBranch: (params) =>
      post<ActionResult & { branch?: string }>(
        "/api/sandbox/bake-to-branch",
        params,
      ),
    activate: (params) => post("/api/sandbox/activate", params),
    compose: (params) =>
      post<ActionResult & { id?: string }>("/api/sandbox/compose", params),
    createPin: (params) =>
      post<ActionResult & { id?: string }>("/api/sandbox/pin", params),
    prompt: (params) => post("/api/sandbox/prompt", params),
    ask: (params) => post("/api/sandbox/ask", params),
    iterate: (params) => post("/api/sandbox/iterate", params),
    retry: (params) => post("/api/sandbox/retry", params),
    renderFailure: (params) => post("/api/sandbox/render-failure", params),
    replace: (params) => post("/api/sandbox/replace", params),
    position: (params) => post("/api/sandbox/position", params),
    registerPinAnchor: (pinId, anchor) => {
      if (anchor) anchorsRef.current.set(pinId, anchor);
      else anchorsRef.current.delete(pinId);
    },
    getPinAnchor: (pinId) => anchorsRef.current.get(pinId),
  };

  return (
    <SandboxContext.Provider value={api}>{children}</SandboxContext.Provider>
  );
}

/** The sandbox api, or undefined outside the provider (cells/fixtures). */
function useSandboxApi(): SandboxApi | undefined {
  return useContext(SandboxContext);
}

export { SandboxProvider, useSandboxApi };
export type { SandboxApi };
