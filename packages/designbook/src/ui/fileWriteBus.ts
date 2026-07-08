/**
 * File-write signal bus (Changes tab MVP, refresh signal #3).
 *
 * Every designbook write path (Code-tab save, adapter flag/theme/i18n/literal
 * writes, discard) announces a completed disk write here so the Changes tab's
 * provider can refetch `git status` immediately instead of waiting for its
 * visible-tab poll. Same minimal window-event style as `navigationBus` — the
 * write sites live across screens/adapters layers, and a window event is the
 * one channel all of them may reach without violating the layer rules.
 */

const EVENT = "designbook:fileWritten";

/** Announce that a designbook write action just hit the disk. */
function notifyFileWritten(path?: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { path } }));
}

/** Subscribe to completed designbook writes; returns an unsubscribe. */
function onFileWritten(handler: (path?: string) => void): () => void {
  function listener(event: Event) {
    const detail = (event as CustomEvent<{ path?: string }>).detail;
    handler(typeof detail?.path === "string" ? detail.path : undefined);
  }
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

export { notifyFileWritten, onFileWritten };
