/**
 * Pure helpers for the sidecar/proxy front, split out so they can be
 * unit-tested without a live server: target-port discovery from a spawned dev
 * server's stdout, HTML escaping, and the two self-contained HTML documents the
 * proxy serves (recovery page + deep-link bootstrap). Everything here is string
 * in / string out — no I/O, no Node server objects.
 */

/** Strip ANSI color escapes so log parsing sees plain text. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\[[0-9;]*m/g, "");
}

/**
 * Parse the port a Vite (or Vite-like) dev server prints, e.g.
 * `  ➜  Local:   http://localhost:3012/`. Returns the first localhost port
 * found on the line, or undefined. Matches localhost / 127.0.0.1 / [::1].
 */
function parseTargetPort(line: string): number | undefined {
  const match = stripAnsi(line).match(
    /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})\b/,
  );
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/**
 * Escalating restart backoff for a crashing target dev server, capped at 30s
 * (the last entry repeats). Reset to the start on a clean boot (port detected).
 */
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000] as const;

/**
 * After this many consecutive failures with no clean boot in between, collapse
 * per-restart logging to a single "failing repeatedly" summary line.
 */
const FAILURE_SUMMARY_THRESHOLD = 5;

/**
 * Delay before the next restart, given how many consecutive failures have
 * happened so far (0 = the first restart). Clamps to the 30s cap.
 */
function restartDelayMs(consecutiveFailures: number): number {
  const i = Math.max(
    0,
    Math.min(consecutiveFailures, RESTART_BACKOFF_MS.length - 1),
  );
  return RESTART_BACKOFF_MS[i];
}

/** The namespace designbook's own api lives under on the proxy origin. */
const DESIGNBOOK_NS = "/__designbook";

/**
 * How the proxy front should route a request, by pathname:
 *   - "ping"     → the `/__designbook/ping` health probe (recovery poll)
 *   - "db-api"   → designbook's own api (namespaced `/__designbook/api/*`)
 *   - "deeplink" → the `/__designbook[/component/<id>]` bootstrap page
 *   - "forward"  → everything else, INCLUDING the app's own `/api/*`, is
 *                  proxied to the target dev server
 *
 * This is the /api-collision fix: plain `/api/*` on the proxy origin is the
 * TARGET's, not designbook's.
 */
function classifyProxyPath(
  pathname: string,
): "ping" | "db-api" | "deeplink" | "forward" {
  if (pathname === `${DESIGNBOOK_NS}/ping`) return "ping";
  if (pathname.startsWith(`${DESIGNBOOK_NS}/api/`)) return "db-api";
  if (
    pathname === DESIGNBOOK_NS ||
    pathname.startsWith(`${DESIGNBOOK_NS}/component/`)
  ) {
    return "deeplink";
  }
  return "forward";
}

/**
 * How the DIRECT api port should route a request, by pathname:
 *   - "db-api-stripped" → namespaced `/__designbook/api/*` (strip the prefix)
 *   - "db-api"          → plain `/api/*` (designbook's here, unproxied)
 *   - "not-found"       → anything else (the direct port serves no app)
 */
function classifyDirectApiPath(
  pathname: string,
): "db-api-stripped" | "db-api" | "not-found" {
  if (pathname.startsWith(`${DESIGNBOOK_NS}/api/`)) return "db-api-stripped";
  if (pathname.startsWith("/api/")) return "db-api";
  return "not-found";
}

/**
 * Strip a leading `/__designbook` namespace from a raw request URL (path +
 * query), so `api.handle` sees `/api/...`. Leaves non-namespaced URLs as-is.
 */
function stripDesignbookNamespace(rawUrl: string): string {
  if (rawUrl.startsWith(DESIGNBOOK_NS)) {
    return rawUrl.slice(DESIGNBOOK_NS.length) || "/";
  }
  return rawUrl;
}

/** Minimal HTML-entity escape for interpolating untrusted text into markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The deep-link bootstrap document served for `/__designbook[/component/<id>]`
 * by BOTH the plugin (inside the target dev server) and the proxy. It never
 * touches the app's own HTML: it stashes intent in sessionStorage and
 * client-redirects to `/`, where the injected boot module reads + clears the
 * keys, auto-expands the overlay, and (if a deep link is present) navigates the
 * workbench to that entry.
 */
/**
 * JSON string literal safe to embed inside an inline `<script>`: escapes `<`
 * (and `>`) so a payload like `</script>` can't close the tag.
 */
function jsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function deepLinkBootstrapHtml(entryId?: string): string {
  const setDeepLink =
    entryId && entryId.length
      ? `s.setItem("designbook:deepLink", ${jsStringLiteral(entryId)});`
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>designbook</title></head><body><script>
(function () {
  try {
    var s = window.sessionStorage;
    s.setItem(${JSON.stringify("designbook:autoExpand")}, "1");
    ${setDeepLink}
  } catch (e) {}
  location.replace("/");
})();
</script></body></html>`;
}

/**
 * The designbook-branded recovery page the proxy serves when the target dev
 * server is unreachable. Self-contained (no external assets, no dist/ui): shows
 * the error + last stderr lines, polls `/__designbook/ping` to auto-reload when
 * the target returns, and mounts a dependency-free Pi chat (the agent session is
 * server-side, so it can fix the crash from here).
 */
function recoveryPageHtml(params: {
  error: string;
  logLines: string[];
}): string {
  const { error, logLines } = params;
  const escapedError = escapeHtml(error);
  const escapedLog = escapeHtml(logLines.join("\n")) || "(no output captured)";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>designbook — app unavailable</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0b0d10; color: #e6e6e6;
    font: 14px/1.5 system-ui, -apple-system, sans-serif;
    display: flex; flex-direction: column; min-height: 100vh;
  }
  header { padding: 20px 24px; border-bottom: 1px solid #1e2228; }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .2px; }
  header .status { margin-top: 6px; font-size: 13px; color: #ffb4b4; }
  main { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 0; min-height: 0; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
  section { padding: 20px 24px; min-height: 0; display: flex; flex-direction: column; }
  section + section { border-left: 1px solid #1e2228; }
  h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: #8a929c; }
  pre.log {
    flex: 1; margin: 0; padding: 12px; overflow: auto; border-radius: 8px;
    background: #05070a; color: #c7ccd1; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word;
  }
  #thread {
    flex: 1; overflow: auto; border-radius: 8px; background: #05070a;
    padding: 12px; margin-bottom: 10px; min-height: 120px;
  }
  .msg { margin: 0 0 12px; white-space: pre-wrap; word-break: break-word; }
  .msg .who { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #8a929c; margin-bottom: 2px; }
  .msg.assistant .who { color: #7fd1b9; }
  form { display: flex; gap: 8px; }
  textarea {
    flex: 1; resize: none; height: 44px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #262b33; background: #0f1318; color: #e6e6e6; font: inherit;
  }
  button {
    padding: 0 16px; border-radius: 8px; border: none; cursor: pointer;
    background: #2d6cdf; color: #fff; font: inherit; font-weight: 600;
  }
  button.abort { background: #3a3f47; }
  .hint { margin-top: 8px; font-size: 12px; color: #6b727b; }
</style>
</head>
<body>
<header>
  <h1>◈ designbook — target app unavailable</h1>
  <div class="status" id="db-status">${escapedError}</div>
</header>
<main>
  <section>
    <h2>Last output</h2>
    <pre class="log" id="db-log">${escapedLog}</pre>
  </section>
  <section>
    <h2>Ask Pi to fix it</h2>
    <div id="thread"></div>
    <form id="chat-form">
      <textarea id="chat-input" placeholder="Describe the crash or ask Pi to fix it…"></textarea>
      <button type="submit" id="send-btn">Send</button>
      <button type="button" class="abort" id="abort-btn">Stop</button>
    </form>
    <div class="hint">The agent session is server-side — its fixes land in your repo, and this page reloads into the app once it recovers.</div>
  </section>
</main>
<script>
(function () {
  var thread = document.getElementById("thread");
  var form = document.getElementById("chat-form");
  var input = document.getElementById("chat-input");
  var streamingEl = null;

  function addMessage(role, text) {
    var el = document.createElement("div");
    el.className = "msg " + role;
    var who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "assistant" ? "Pi" : "You";
    var body = document.createElement("div");
    body.textContent = text;
    el.appendChild(who); el.appendChild(body);
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
    return body;
  }

  var es = new EventSource("/__designbook/api/events");
  es.addEventListener("pi-event", function (ev) {
    var event;
    try { event = JSON.parse(ev.data); } catch (e) { return; }
    if (event.type === "message_start" && event.message && event.message.role === "assistant") {
      streamingEl = addMessage("assistant", "");
    }
    if (event.type === "message_update" && event.assistantMessageEvent
        && event.assistantMessageEvent.type === "text_delta"
        && event.assistantMessageEvent.delta) {
      if (!streamingEl) streamingEl = addMessage("assistant", "");
      streamingEl.textContent += event.assistantMessageEvent.delta;
      thread.scrollTop = thread.scrollHeight;
    }
    if (event.type === "agent_end") { streamingEl = null; }
  });
  es.addEventListener("server-error", function (ev) {
    try { addMessage("assistant", "[error] " + (JSON.parse(ev.data).message || "")); } catch (e) {}
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    addMessage("user", text);
    input.value = "";
    streamingEl = null;
    fetch("/__designbook/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text })
    }).catch(function () { addMessage("assistant", "[error] failed to reach the agent"); });
  });

  document.getElementById("abort-btn").addEventListener("click", function () {
    fetch("/__designbook/api/abort", { method: "POST" }).catch(function () {});
  });

  // Auto-recover: poll the proxy's health probe; reload into the app when the
  // target dev server comes back.
  setInterval(function () {
    fetch("/__designbook/ping", { method: "HEAD", cache: "no-store" })
      .then(function (r) { if (r.ok) location.reload(); })
      .catch(function () {});
  }, 2000);
})();
</script>
</body>
</html>`;
}

export {
  classifyDirectApiPath,
  classifyProxyPath,
  deepLinkBootstrapHtml,
  DESIGNBOOK_NS,
  escapeHtml,
  FAILURE_SUMMARY_THRESHOLD,
  parseTargetPort,
  recoveryPageHtml,
  RESTART_BACKOFF_MS,
  restartDelayMs,
  stripAnsi,
  stripDesignbookNamespace,
};
