/**
 * Tiny static file server for the REPO ROOT on the fixed port 8817.
 *
 *   pnpm --dir evals/context-arch run viewer
 *
 * Exists so the eval dashboard's "view conversation" links work:
 *   http://localhost:8817/tools/pi-session-viewer/index.html
 *     ?session=/evals/context-arch/runs/<run>/<task>/session.jsonl
 * The viewer fetches the session JSONL over http (fetch is blocked on
 * file://), so both a locally-opened dashboard.html and the published
 * artifact page can deep-link into conversations while this runs.
 * Zero deps — node:http only. Read-only, GET/HEAD, path-traversal safe.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", ".."); // evals/context-arch/src -> repo root
const PORT = 8817; // fixed — dashboard links are hardcoded to this port

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end("method not allowed");
    return;
  }
  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  let filePath = normalize(join(repoRoot, urlPath));
  if (filePath !== repoRoot && !filePath.startsWith(repoRoot + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${urlPath}`);
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "content-length": statSync(filePath).size,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`serving ${repoRoot} at http://localhost:${PORT}`);
  console.log(
    `viewer: http://localhost:${PORT}/tools/pi-session-viewer/index.html?session=/evals/context-arch/runs/<run>/<task>/session.jsonl`,
  );
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`port ${PORT} already in use — is the viewer server already running?`);
    process.exit(1);
  }
  throw err;
});
