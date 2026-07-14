/**
 * Props-panel HTTP routes (docs/specs/props-panel.md):
 *   - GET  /api/props-schema — typed extraction, degraded response;
 *   - POST /api/props-edit   — real-file usage-site write (no active
 *     conversation), spread-props read-only bail-out, and --read-only block.
 *
 * Drives createApi with mock req/res (no sockets), against a temp project. The
 * no-conversation path writes the real file directly, exactly like the manual
 * data edits.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { createApi } from "./api.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const USAGE = `export function Page() {
  return <ProductCard title="Old" price={10} className="card" />;
}
`;

function project(readOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "db-props-routes-"));
  tempDirs.push(root);
  const configPath = join(root, "designbook.config.tsx");
  writeFileSync(configPath, "export default { sets: [] };");
  writeFileSync(join(root, "package.json"), '{ "name": "app" }');
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "Page.tsx"), USAGE);
  // A committed git repo so a conversation-mode edit COULD route (these tests
  // exercise the no-conversation real-file path, but createApi is happier in a
  // repo).
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    { cwd: root },
  );
  const api = createApi({ configPath, projectRoot: root, port: 8804, readOnly });
  return { root, api };
}

function mockResponse() {
  const state = { status: 0, body: "" };
  return {
    state,
    response: {
      writeHead(status: number) {
        state.status = status;
      },
      setHeader() {},
      end(chunk?: unknown) {
        if (typeof chunk === "string") state.body += chunk;
      },
      on() {},
      write: () => true,
    },
  };
}

async function call(
  api: ReturnType<typeof createApi>,
  method: string,
  pathname: string,
  body?: unknown,
) {
  const request = (
    body === undefined
      ? { method, headers: { host: "localhost:8804" } }
      : Object.assign(Readable.from([JSON.stringify(body)]), {
          method,
          headers: { host: "localhost:8804" },
        })
  ) as IncomingMessage;
  const mock = mockResponse();
  await api.handle(
    request,
    mock.response as never,
    new URL(`http://localhost:8804${pathname}`),
  );
  return { status: mock.state.status, json: JSON.parse(mock.state.body || "null") };
}

describe("GET /api/props-schema", () => {
  it("returns a well-formed schema or a degraded response", async () => {
    const { api } = project();
    const result = await call(
      api,
      "GET",
      "/api/props-schema?file=src/Page.tsx&export=Page",
    );
    expect(result.status).toBe(200);
    // Either typed props or an explicit unavailability — never a throw.
    expect("props" in result.json || "unavailable" in result.json).toBe(true);
  });

  it("degrades for a non-source file", async () => {
    const { api } = project();
    const result = await call(
      api,
      "GET",
      "/api/props-schema?file=package.json&export=X",
    );
    expect(result.status).toBe(200);
    expect(result.json).toHaveProperty("unavailable");
  });
});

describe("POST /api/props-edit (no active conversation → real file)", () => {
  it("writes the JSX attribute at the usage site", async () => {
    const { root, api } = project();
    const result = await call(api, "POST", "/api/props-edit", {
      file: "src/Page.tsx",
      ownerExportName: "Page",
      elementName: "ProductCard",
      className: "card",
      prop: "title",
      kind: "string",
      value: "New Title",
    });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    const written = readFileSync(join(root, "src", "Page.tsx"), "utf8");
    expect(written).toContain('title="New Title"');
    expect(written).toContain("price={10}");
  });

  it("returns read-only (unresolvable) on spread props", async () => {
    const { root, api } = project();
    writeFileSync(
      join(root, "src", "Spread.tsx"),
      "export function P(props){ return <ProductCard {...props} title=\"x\" />; }\n",
    );
    const result = await call(api, "POST", "/api/props-edit", {
      file: "src/Spread.tsx",
      elementName: "ProductCard",
      prop: "title",
      kind: "string",
      value: "y",
    });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(false);
    expect(result.json.unresolvable).toBeTruthy();
  });

  it("removes the attribute on reset", async () => {
    const { root, api } = project();
    const result = await call(api, "POST", "/api/props-edit", {
      file: "src/Page.tsx",
      elementName: "ProductCard",
      className: "card",
      prop: "price",
      reset: true,
    });
    expect(result.status).toBe(200);
    const written = readFileSync(join(root, "src", "Page.tsx"), "utf8");
    expect(written).not.toContain("price={10}");
    expect(written).toContain('title="Old"');
  });

  it("is blocked in --read-only mode", async () => {
    const { api } = project(true);
    const result = await call(api, "POST", "/api/props-edit", {
      file: "src/Page.tsx",
      elementName: "ProductCard",
      prop: "title",
      kind: "string",
      value: "z",
    });
    expect(result.status).toBe(403);
  });
});
