/**
 * Shared `/api/events` EventSource bus.
 *
 * The design server multiplexes EVERYTHING the workbench needs — chat
 * `state`/`pi-event`/`server-notice`/`server-error`, `branch-status`,
 * `variations-event`, `sandbox-event` — as NAMED events on a single
 * `/api/events` SSE stream. The UI used to open a separate EventSource per
 * feature (chat, worktrees, changes, variations, sandbox), so a workbench held
 * 5-6 connections to one HTTP/1.1 origin; the App-page iframe doubled that,
 * blowing past Chrome's ~6-per-origin cap and starving every later fetch (POSTs
 * pending forever, the branch selector stuck on "Preparing worktree…", missed
 * variant-ready events).
 *
 * This module holds ONE refcounted EventSource per document. Subscribers add a
 * handler for a named event; the FIRST subscriber (of any name/status) opens
 * the stream, the LAST unsubscribe closes it after a short grace — so a tab
 * switch's unmount→remount doesn't churn the connection. EventSource's own
 * auto-reconnect is preserved: the instance is kept across transient errors, so
 * every handler survives a drop/reconnect without re-subscribing.
 *
 * HIDDEN-TAB LIFECYCLE (connection-starvation, round 2): one stream per
 * document still means N designbook TABS hold N streams — plus each tab's
 * vite ws, several stale background tabs exhaust Chrome's ~6-per-origin
 * HTTP/1.1 pool and a fresh tab's POSTs queue forever. So the stream is also
 * tied to visibility: when the document stays hidden past a grace period the
 * stream is released (subscriptions persist), and the next `visibilitychange`
 * to visible reopens it. Recovery is inherent — the server replays full
 * `state` on every connect, so a refocused tab catches up immediately.
 * A quick tab-flip (hidden < the grace) never touches the connection, so the
 * visible tab's chat streaming is unaffected.
 *
 * SSR/test safe: nothing is constructed at import; the EventSource is created
 * lazily on first subscribe through an injectable factory (tests pass a fake,
 * since the node test env has no `EventSource`), and the visibility listener
 * is attached lazily on first subscribe (guarded on `document` existing).
 */

import { apiUrl } from "@designbook-ui/designbook";

/** A named-event handler — receives the raw SSE MessageEvent; each call site
 * parses `.data` itself (preserving its existing per-site semantics). */
type ApiEventHandler = (event: MessageEvent) => void;

/** Mirrors EventSource's connection lifecycle events. */
type ConnectionStatus = "open" | "error";
type ConnectionStatusHandler = (status: ConnectionStatus) => void;

type EventSourceFactory = (url: string) => EventSource;

/** Grace before the idle stream is closed — long enough that a quick
 * unmount→remount (tab switch, App-page iframe reflow) reuses the connection
 * instead of tearing it down and reopening. */
const CLOSE_DELAY_MS = 5_000;

/** Grace before a HIDDEN document releases the stream — long enough that a
 * quick tab-flip keeps the live connection (no reconnect churn, chat keeps
 * streaming), short enough that a pile of stale background tabs frees the
 * per-origin pool promptly. */
const HIDDEN_CLOSE_DELAY_MS = 15_000;

/** EventSource.OPEN — inlined so the module never references the global at
 * import time (SSR/test safety). */
const READY_STATE_OPEN = 1;

// Logical subscriptions, keyed by event name. These persist across the ES's
// open/close cycle; the native listeners below are re-attached whenever a new
// ES is opened.
const handlersByName = new Map<string, Set<ApiEventHandler>>();
const statusHandlers = new Set<ConnectionStatusHandler>();

let source: EventSource | undefined;
// Names with a native listener on the CURRENT `source` (cleared when it closes,
// since listeners die with the instance).
let attachedNames = new Set<string>();
let subscriberCount = 0;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

let createEventSource: EventSourceFactory = (url) => new EventSource(url);

/** The slice of `document` the hidden-tab lifecycle needs (test seam). */
type VisibilityDocument = {
  hidden: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** Test-injected document; the real one is read lazily (SSR/test safety). */
let visibilityDocOverride: VisibilityDocument | undefined;
/** The document the visibilitychange listener is currently attached to. */
let hookedDoc: VisibilityDocument | undefined;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
/** True while the stream is released BECAUSE the tab is hidden — blocks
 * reopen until the next visibilitychange to visible. */
let suspendedWhileHidden = false;

function visibilityDocument(): VisibilityDocument | undefined {
  if (visibilityDocOverride) return visibilityDocOverride;
  return typeof document === "undefined" ? undefined : document;
}

function dispatch(name: string, event: MessageEvent): void {
  const handlers = handlersByName.get(name);
  if (!handlers) return;
  // Snapshot: a handler may subscribe/unsubscribe during dispatch.
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch {
      // A rogue subscriber must not starve the others on the shared stream.
    }
  }
}

function notifyStatus(status: ConnectionStatus): void {
  for (const handler of [...statusHandlers]) {
    try {
      handler(status);
    } catch {
      // Isolate a throwing status listener from the rest.
    }
  }
}

function attachNativeListener(name: string): void {
  if (!source || attachedNames.has(name)) return;
  attachedNames.add(name);
  source.addEventListener(name, (event) =>
    dispatch(name, event as MessageEvent),
  );
}

function openIfNeeded(): void {
  // A new subscriber during the grace window keeps the live connection.
  if (closeTimer !== undefined) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  // Suspended = the tab is hidden past its grace: record subscriptions but
  // hold the pool slot until the tab is visible again (syncVisibility reopens).
  if (suspendedWhileHidden) return;
  if (source) return;
  source = createEventSource(apiUrl("/api/events"));
  attachedNames = new Set();
  source.addEventListener("open", () => notifyStatus("open"));
  source.addEventListener("error", () => notifyStatus("error"));
  for (const name of handlersByName.keys()) attachNativeListener(name);
}

/** Attach the visibilitychange hook once per document (lazily, from retain —
 * never at import). Re-attaches if the test seam swaps the document. */
function ensureVisibilityHook(): void {
  const doc = visibilityDocument();
  if (!doc || hookedDoc === doc) return;
  hookedDoc?.removeEventListener("visibilitychange", syncVisibility);
  hookedDoc = doc;
  doc.addEventListener("visibilitychange", syncVisibility);
}

/** Reconcile the stream with the document's visibility: hidden arms the
 * release timer; visible cancels it and reopens a suspended stream (the
 * fresh connection's `state` replay restores thread/canvas state). */
function syncVisibility(): void {
  const doc = visibilityDocument();
  if (!doc) return;
  if (doc.hidden) {
    if (hiddenTimer !== undefined || suspendedWhileHidden || !source) return;
    hiddenTimer = setTimeout(() => {
      hiddenTimer = undefined;
      const current = visibilityDocument();
      if (!current || !current.hidden) return; // Refocused meanwhile.
      suspendedWhileHidden = true;
      if (source) {
        source.close();
        source = undefined;
        attachedNames = new Set();
        // The hidden tab's indicator honestly reads Disconnected until the
        // refocus reopen fires "open".
        notifyStatus("error");
      }
    }, HIDDEN_CLOSE_DELAY_MS);
  } else {
    if (hiddenTimer !== undefined) {
      clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
    }
    if (suspendedWhileHidden) {
      suspendedWhileHidden = false;
      if (subscriberCount > 0) openIfNeeded();
    }
  }
}

function scheduleCloseIfIdle(): void {
  if (subscriberCount > 0 || closeTimer !== undefined) return;
  closeTimer = setTimeout(() => {
    closeTimer = undefined;
    // A subscriber may have arrived while the timer was pending.
    if (subscriberCount > 0) return;
    source?.close();
    source = undefined;
    attachedNames = new Set();
  }, CLOSE_DELAY_MS);
}

function retain(): void {
  subscriberCount += 1;
  ensureVisibilityHook();
  openIfNeeded();
  // A tab opened in the background (hidden from birth) must still arm the
  // hidden-release timer for the stream it just opened.
  syncVisibility();
}

function release(): void {
  subscriberCount -= 1;
  if (subscriberCount <= 0) {
    subscriberCount = 0;
    scheduleCloseIfIdle();
  }
}

/**
 * Subscribe to a NAMED `/api/events` event. Returns an unsubscribe. The first
 * subscriber opens the shared stream; the last unsubscribe closes it after the
 * grace delay. The handler receives the raw MessageEvent — parse `.data`
 * yourself, matching the previous per-site behavior.
 */
function subscribeApiEvents(
  eventName: string,
  handler: ApiEventHandler,
): () => void {
  let handlers = handlersByName.get(eventName);
  if (!handlers) {
    handlers = new Set();
    handlersByName.set(eventName, handlers);
  }
  handlers.add(handler);
  retain();
  // retain()'s openIfNeeded attaches all known names when it opens a fresh ES;
  // this covers the case where the ES was already open (new name mid-stream).
  attachNativeListener(eventName);

  let active = true;
  return () => {
    if (!active) return; // Idempotent — never double-releases the refcount.
    active = false;
    const set = handlersByName.get(eventName);
    set?.delete(handler);
    if (set && set.size === 0) handlersByName.delete(eventName);
    release();
  };
}

/**
 * Subscribe to the stream's connection status ("open"/"error"), for the
 * chat's Connected/Disconnected indicator. Returns an unsubscribe.
 */
function subscribeConnectionStatus(
  handler: ConnectionStatusHandler,
): () => void {
  statusHandlers.add(handler);
  retain();
  // A late subscriber (stream already open) would otherwise wait for the next
  // reconnect to learn it's connected — surface the current state now.
  if (source && source.readyState === READY_STATE_OPEN) handler("open");

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    statusHandlers.delete(handler);
    release();
  };
}

/** Test seam: swap the EventSource constructor (the node test env has none). */
function setEventSourceFactoryForTests(
  factory: EventSourceFactory | undefined,
): void {
  createEventSource = factory ?? ((url) => new EventSource(url));
}

/** Test seam: swap the document driving the hidden-tab lifecycle (the node
 * test env has none). Pass undefined to restore the real-global lookup. */
function setVisibilityDocumentForTests(
  doc: VisibilityDocument | undefined,
): void {
  hookedDoc?.removeEventListener("visibilitychange", syncVisibility);
  hookedDoc = undefined;
  visibilityDocOverride = doc;
}

/** Test seam: tear the bus down between cases. */
function resetEventBusForTests(): void {
  if (closeTimer !== undefined) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  if (hiddenTimer !== undefined) {
    clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
  }
  suspendedWhileHidden = false;
  hookedDoc?.removeEventListener("visibilitychange", syncVisibility);
  hookedDoc = undefined;
  visibilityDocOverride = undefined;
  source?.close();
  source = undefined;
  attachedNames = new Set();
  handlersByName.clear();
  statusHandlers.clear();
  subscriberCount = 0;
}

export {
  resetEventBusForTests,
  setEventSourceFactoryForTests,
  setVisibilityDocumentForTests,
  subscribeApiEvents,
  subscribeConnectionStatus,
};
export type { ApiEventHandler, ConnectionStatus, ConnectionStatusHandler };
