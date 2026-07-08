/**
 * Client-side call to the plugin's `/__designbook/flush-writes` route — awaits one recent-writes poll + module-invalidation pass on the
 * target app's OWN dev server (see `flushWrites.ts` in the node package)
 * BEFORE the App-page frame text tool reloads the frame, so the reload can
 * never again race the invalidation the way `AppFrameTextOverlay`'s old
 * `withFrameReloadOnSave` doc comment described.
 *
 * `buildFrameSrc` (`appFrame.ts`) always gives the iframe a same-origin
 * RELATIVE `src`, so this same relative path — fetched from the top window,
 * where `AppFrameTextOverlay` runs — resolves to the exact origin serving the
 * frame; no need to reach through `iframe.contentWindow` for a same-origin
 * fetch.
 *
 * Bounded: a slow or unreachable flush must never block the reload it exists
 * to make redundant — this never rejects, and always settles by `timeoutMs`
 * at the latest either way.
 */

const FLUSH_WRITES_PATH = "/__designbook/flush-writes";

async function flushWrites(
  timeoutMs = 2000,
  doFetch: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await doFetch(FLUSH_WRITES_PATH, {
      method: "POST",
      signal: controller.signal,
    });
  } catch {
    // Unreachable, aborted, or errored — the caller reloads regardless; a
    // missed flush just means the pre-P3.1 1s-poll behavior, not a failure.
  } finally {
    clearTimeout(timer);
  }
}

export { FLUSH_WRITES_PATH, flushWrites };
