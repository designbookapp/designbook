/**
 * Request-time same-origin/host enforcement for designbook's own `/api/*`
 * routes (host mode's `server.ts` and the sidecar's `/__designbook/api/*` +
 * direct api port in `sidecar.ts`). Distinct from `applyApiCors()`'s CORS
 * response headers (a browser-enforced convention that never rejects a
 * request itself) — this is the actual reject gate, and it also runs for
 * non-browser clients (curl, another process).
 *
 * NEVER apply this to the sidecar's proxied passthrough (the target app's own
 * `/api/*`) — that's the app's API, not designbook's.
 *
 * See docs/drafts/pi-security-hardening.md, product backlog #2.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const WILDCARD_HOSTNAMES = new Set(["0.0.0.0", "::", ""]);

/** Strip IPv6 brackets (`[::1]` -> `::1`) and lower-case. */
function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  return unbracketed.toLowerCase();
}

/** True for localhost/127.0.0.1/::1 (and their bracketed IPv6 form) — treated as one equivalence class. */
function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

/** True for a bind-all address (0.0.0.0 / :: / empty) — not a specific hostname to compare against. */
function isWildcardHostname(hostname: string): boolean {
  return WILDCARD_HOSTNAMES.has(normalizeHostname(hostname));
}

/**
 * True when `host` is a non-loopback bind address: an explicit `--host`
 * value that is neither undefined/empty nor a loopback alias. Covers both
 * wildcard binds (`0.0.0.0`, `::`) and a specific LAN IP/hostname. Used by
 * the CLI's `--allow-lan` guard (product backlog #1).
 */
function isNonLoopbackBindHost(host: string | undefined): boolean {
  if (!host) return false;
  return !isLoopbackHostname(host);
}

/** Parse a `Host` header (`host` or `host:port`, incl. bracketed IPv6) into hostname/port. */
function parseHostHeader(
  value: string,
): { hostname: string; port?: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return undefined;
    const hostname = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(":") ? rest.slice(1) : undefined;
    return { hostname, port };
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) return { hostname: trimmed, port: undefined };
  return {
    hostname: trimmed.slice(0, lastColon),
    port: trimmed.slice(lastColon + 1),
  };
}

/** Parse an `Origin` header (a full origin URL) into hostname/port (port defaulted from scheme). */
function parseOriginHeader(
  value: string,
): { hostname: string; port: string } | undefined {
  try {
    const url = new URL(value);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return { hostname: normalizeHostname(url.hostname), port };
  } catch {
    return undefined;
  }
}

type SameOriginCheckInput = {
  /** The request's `Origin` header, if present. */
  origin: string | undefined;
  /** The request's `Host` header. */
  host: string | undefined;
  /** The address this server was bound to (the `--host` value, or undefined for the default). */
  boundHost: string | undefined;
  /** The port this server is listening on. */
  boundPort: number;
};

/**
 * Pure same-origin/host check for a designbook API request. Two independent
 * gates, both must pass:
 *
 *  1. Origin gate — only fires when an `Origin` header is present. Same-origin
 *     navigations, curl, and server-to-server calls send no `Origin` and
 *     always pass this gate. When present, it must resolve to this server's
 *     own origin: loopback-alias-equivalent when bound to loopback (or
 *     unbound, which defaults to loopback), exactly matching the bound host
 *     for an explicit non-wildcard bind, or matching the request's own `Host`
 *     header when bound to a wildcard address (LAN mode) — there is no fixed
 *     literal to compare against for `0.0.0.0`/`::`, so "does Origin agree
 *     with the address the client actually addressed" is the same-origin
 *     test.
 *
 *  2. Host gate (DNS-rebinding guard) — always evaluated. When bound to
 *     loopback, the `Host` header's hostname must itself be a loopback alias
 *     (lenient about which alias, and about port). Non-loopback binds (LAN
 *     mode, an explicit LAN IP) can't be validated against a fixed literal,
 *     so this gate is permissive there — the origin gate does the real work.
 */
function isSameOriginApiRequest(input: SameOriginCheckInput): boolean {
  const { origin, host, boundHost, boundPort } = input;
  const boundLoopback = boundHost === undefined || isLoopbackHostname(boundHost);
  const boundWildcard = boundHost !== undefined && isWildcardHostname(boundHost);
  const parsedHost = host ? parseHostHeader(host) : undefined;

  const hostGatePass = (() => {
    if (!parsedHost) return true; // No Host header to check — permissive.
    if (boundLoopback) return isLoopbackHostname(parsedHost.hostname);
    return true; // Wildcard / explicit non-loopback bind: origin gate handles it.
  })();

  const originGatePass = (() => {
    if (!origin) return true; // No Origin header — same-origin nav, curl, server-to-server.
    const parsedOrigin = parseOriginHeader(origin);
    if (!parsedOrigin) return false; // Malformed Origin — reject.
    const boundPortStr = String(boundPort);
    if (boundPortStr !== parsedOrigin.port) return false;

    if (boundLoopback) {
      return isLoopbackHostname(parsedOrigin.hostname);
    }
    if (boundWildcard) {
      if (!parsedHost) return false;
      return parsedOrigin.hostname === normalizeHostname(parsedHost.hostname);
    }
    // Explicit non-wildcard, non-loopback bind (e.g. `--host 192.168.1.20`).
    return parsedOrigin.hostname === normalizeHostname(boundHost as string);
  })();

  return hostGatePass && originGatePass;
}

import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Thin non-pure wrapper around `isSameOriginApiRequest()` for the two call
 * sites (host mode's `server.ts`, the sidecar's proxy + direct api origins in
 * `sidecar.ts`): reads the `Origin`/`Host` headers off the request, and — when
 * the request fails the same-origin check — writes a terse 403 JSON response
 * and returns `true` (the caller should stop, having already sent a response).
 * Returns `false` when the request is same-origin and the caller should
 * proceed to `api.handle()`.
 */
function rejectCrossOriginApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  boundHost: string | undefined,
  boundPort: number,
): boolean {
  const ok = isSameOriginApiRequest({
    origin: request.headers.origin,
    host: request.headers.host,
    boundHost,
    boundPort,
  });
  if (ok) return false;
  response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "Cross-origin request rejected." }));
  return true;
}

/**
 * The generic tool-discovery probe (`/api/hello`, E1) is the ONLY
 * cross-origin-exempt designbook route: device plugins run from opaque
 * origins (the Figma plugin's UI iframe is a `data:` URL, so every fetch it
 * makes carries `Origin: null`), and the handler answers with public identity
 * info only ({app, version, port}) and sets `Access-Control-Allow-Origin: *`
 * itself. `/api/figma-hello` is the legacy alias the shipped Figma plugin
 * probes. Integration plugins CANNOT declare additional exemptions.
 */
const CROSS_ORIGIN_EXEMPT_API_PATHS = new Set([
  "/api/hello",
  "/api/figma-hello",
]);

function isCrossOriginExemptApiPath(pathname: string): boolean {
  return CROSS_ORIGIN_EXEMPT_API_PATHS.has(pathname);
}

export {
  CROSS_ORIGIN_EXEMPT_API_PATHS,
  isCrossOriginExemptApiPath,
  isNonLoopbackBindHost,
  isSameOriginApiRequest,
  rejectCrossOriginApiRequest,
};
export type { SameOriginCheckInput };
