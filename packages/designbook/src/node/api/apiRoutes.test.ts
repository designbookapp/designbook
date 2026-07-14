/**
 * Route-level guards for the integration seam (S2):
 *
 *   - `/api/hello` is the generic discovery route (ACAO:*, public identity
 *     payload) and `/api/figma-hello` is its legacy alias — same handler,
 *     same headers;
 *   - the figma REST routes answer on BOTH the canonical `/api/x/figma/…`
 *     paths and the legacy `/api/figma/…` aliases (same behavior);
 *   - the config's literal `integrations: { figma: false }` disables the
 *     figma routes and its bridge upgrade path node-side (D1);
 *   - `--read-only` still blocks the core write endpoints through the merged
 *     block-set path.
 *
 * Uses createApi with mock req/res objects — no sockets, no Pi session (none
 * of these routes touch getSession()).
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
import { instanceNavigationUrl } from "../lib/worktrees.ts";
import { createApi } from "./api.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function projectWithConfig(configSource: string) {
  const root = mkdtempSync(join(tmpdir(), "db-api-routes-"));
  tempDirs.push(root);
  const configPath = join(root, "designbook.config.tsx");
  writeFileSync(configPath, configSource);
  return { root, configPath };
}

function apiFor(configSource = "export default { sets: [] };", readOnly = false) {
  const { root, configPath } = projectWithConfig(configSource);
  return createApi({ configPath, projectRoot: root, port: 8802, readOnly });
}

function apiWithWorktreeProxy(
  worktreeProxy: NonNullable<Parameters<typeof createApi>[0]["worktreeProxy"]>,
) {
  const { root, configPath } = projectWithConfig(
    "export default { sets: [] };",
  );
  return createApi({
    configPath,
    projectRoot: root,
    port: 8802,
    worktreeProxy,
  });
}

type MockResponse = {
  status?: number;
  headers: Record<string, unknown>;
  body: string;
  response: {
    writeHead: (status: number, headers?: Record<string, unknown>) => void;
    setHeader: (name: string, value: unknown) => void;
    end: (chunk?: unknown) => void;
    on: () => void;
    write: () => boolean;
  };
};

function mockResponse(): MockResponse {
  const mock: MockResponse = {
    headers: {},
    body: "",
    response: {
      writeHead(status, headers) {
        mock.status = status;
        Object.assign(mock.headers, headers ?? {});
      },
      setHeader(name, value) {
        mock.headers[name.toLowerCase()] = value;
      },
      end(chunk) {
        if (typeof chunk === "string") mock.body += chunk;
      },
      on() {},
      write: () => true,
    },
  };
  return mock;
}

function request(method: string): IncomingMessage {
  return { method, headers: { host: "localhost:8802" } } as IncomingMessage;
}

async function call(
  api: ReturnType<typeof createApi>,
  method: string,
  pathname: string,
) {
  const mock = mockResponse();
  await api.handle(
    request(method),
    mock.response as never,
    new URL(`http://localhost:8802${pathname}`),
  );
  return mock;
}

describe("discovery route (E1)", () => {
  it("serves /api/hello with ACAO:* and identity payload", async () => {
    const api = apiFor();
    const result = await call(api, "GET", "/api/hello");
    expect(result.status).toBe(200);
    expect(result.headers["access-control-allow-origin"]).toBe("*");
    const payload = JSON.parse(result.body) as Record<string, unknown>;
    expect(payload.app).toBe("designbook");
    expect(payload.port).toBe(8802);
    expect(typeof payload.version).toBe("string");
  });

  it("serves /api/figma-hello as an identical alias", async () => {
    const api = apiFor();
    const hello = await call(api, "GET", "/api/hello");
    const alias = await call(api, "GET", "/api/figma-hello");
    expect(alias.status).toBe(200);
    expect(alias.headers["access-control-allow-origin"]).toBe("*");
    expect(alias.body).toBe(hello.body);
  });
});

describe("sandbox source-owner lookup (read-only)", () => {
  it("resolves the first owner name the export scan finds a file for", async () => {
    const { root, configPath } = projectWithConfig(
      "export default { sets: [] };",
    );
    mkdirSync(join(root, "src", "pages"), { recursive: true });
    writeFileSync(
      join(root, "src", "pages", "HomePage.tsx"),
      "export function HomePage() { return null; }\n",
    );
    const api = createApi({ configPath, projectRoot: root, port: 8802 });
    // `Link` (a node_modules component) scans to nothing; `HomePage` wins.
    const result = await call(
      api,
      "GET",
      "/api/sandbox/source-owner?names=Link,HomePage",
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      file: "src/pages/HomePage.tsx",
      exportName: "HomePage",
    });
  });

  it("400s without names; 200 {} when nothing resolves", async () => {
    const api = apiFor();
    const missingParam = await call(api, "GET", "/api/sandbox/source-owner");
    expect(missingParam.status).toBe(400);
    const noMatch = await call(
      api,
      "GET",
      "/api/sandbox/source-owner?names=Nowhere",
    );
    expect(noMatch.status).toBe(200);
    expect(JSON.parse(noMatch.body)).toEqual({});
  });
});

describe("figma integration routes (canonical + alias)", () => {
  it("serves status on /api/x/figma/status and /api/figma/status", async () => {
    const api = apiFor();
    for (const path of ["/api/x/figma/status", "/api/figma/status"]) {
      const result = await call(api, "GET", path);
      expect(result.status, path).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ connected: false, info: null });
    }
  });

  it("answers 409 on variables reads while no plugin is connected", async () => {
    const api = apiFor();
    for (const path of ["/api/x/figma/variables", "/api/figma/variables"]) {
      const result = await call(api, "GET", path);
      expect(result.status, path).toBe(409);
    }
  });

  it("answers 409 on export (fidelity harness) while no plugin is connected", async () => {
    const api = apiFor();
    for (const path of ["/api/x/figma/export", "/api/figma/export"]) {
      const result = await call(api, "POST", path);
      expect(result.status, path).toBe(409);
    }
  });

  it("keeps unknown routes 404", async () => {
    const api = apiFor();
    const result = await call(api, "GET", "/api/x/figma/nope");
    expect(result.status).toBe(404);
  });
});

describe("integrations: { figma: false } (D1, node side)", () => {
  const disabledConfig = `
    export default defineConfig({
      sets: [],
      integrations: { figma: false },
    });
  `;

  it("unregisters the figma routes", async () => {
    const api = apiFor(disabledConfig);
    for (const path of ["/api/figma/status", "/api/x/figma/status"]) {
      const result = await call(api, "GET", path);
      expect(result.status, path).toBe(404);
    }
  });

  it("keeps the generic discovery route", async () => {
    const api = apiFor(disabledConfig);
    const result = await call(api, "GET", "/api/hello");
    expect(result.status).toBe(200);
  });

  it("stops accepting bridge upgrades", () => {
    const api = apiFor(disabledConfig);
    const handled = api.handleBridgeUpgrade(
      "/api/figma-bridge",
      request("GET"),
      { destroy() {}, write: () => true, on() {} } as never,
      Buffer.alloc(0),
    );
    expect(handled).toBe(false);
  });
});

describe("bridge upgrade routing", () => {
  it("ignores non-bridge upgrade paths", () => {
    const api = apiFor();
    for (const path of ["/api/events", "/", "/api/bridge/other"]) {
      expect(
        api.handleBridgeUpgrade(
          path,
          request("GET"),
          { destroy() {}, write: () => true, on() {} } as never,
          Buffer.alloc(0),
        ),
        path,
      ).toBe(false);
    }
  });

  it("claims /api/bridge/figma and the legacy /api/figma-bridge alias", () => {
    const api = apiFor();
    for (const path of ["/api/bridge/figma", "/api/figma-bridge"]) {
      // A non-WS mock request fails the ws handshake (the bridge aborts it),
      // but the path is CLAIMED — the caller must not proxy/ignore it.
      const socket = {
        destroy() {},
        write: () => true,
        on() {},
        once() {},
        end() {},
        removeListener() {},
        readable: true,
        writable: true,
      };
      expect(
        api.handleBridgeUpgrade(
          path,
          request("GET"),
          socket as never,
          Buffer.alloc(0),
        ),
        path,
      ).toBe(true);
    }
  });
});

describe("--read-only merged block set", () => {
  it("still 403s the core write endpoints", async () => {
    const api = apiFor(undefined, true);
    const result = await call(api, "POST", "/api/file");
    expect(result.status).toBe(403);
  });

  it("does not block the figma read routes", async () => {
    const api = apiFor(undefined, true);
    const result = await call(api, "GET", "/api/figma/status");
    expect(result.status).toBe(200);
  });
});

describe("json write endpoint: add/mutate classification, manual origin unrestricted", () => {
  function postJson(body: unknown): IncomingMessage {
    const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
    (req as { method?: string }).method = "POST";
    (req as { headers?: unknown }).headers = { host: "localhost:8802" };
    return req;
  }
  async function callJson(
    api: ReturnType<typeof createApi>,
    body: unknown,
  ): Promise<MockResponse> {
    const mock = mockResponse();
    await api.handle(
      postJson(body),
      mock.response as never,
      new URL("http://localhost:8802/api/json"),
    );
    return mock;
  }

  // Manual text-tool / adapter-UI writes go through this endpoint (NOT the
  // sandbox turn path), so they stay unrestricted real-layer edits: the
  // add-vs-mutate classification is SURFACED (returned as `mode`) but never
  // enforced or recorded — that is the sandbox-origin path's job.
  it("surfaces mode=add|mutate and applies both — a mutate is never a 403", async () => {
    const { root, configPath } = projectWithConfig("export default { sets: [] };");
    writeFileSync(
      join(root, "data.json"),
      `${JSON.stringify({ a: { b: "1" } }, null, 2)}\n`,
    );
    const api = createApi({ configPath, projectRoot: root, port: 8802 });

    const mutate = await callJson(api, {
      path: "data.json",
      keyPath: "a.b",
      value: "2",
    });
    expect(mutate.status).toBe(200);
    expect(JSON.parse(mutate.body)).toMatchObject({ ok: true, mode: "mutate" });

    const add = await callJson(api, {
      path: "data.json",
      keyPath: "a.c",
      value: "3",
      create: true,
    });
    expect(add.status).toBe(200);
    expect(JSON.parse(add.body)).toMatchObject({ ok: true, mode: "add" });

    expect(JSON.parse(readFileSync(join(root, "data.json"), "utf8"))).toEqual({
      a: { b: "2", c: "3" },
    });
  });
});

describe("worktrees route in proxy topology (C3.2 stable-URL switch)", () => {
  function postWorktree(branch: string): IncomingMessage {
    const req = Readable.from([
      JSON.stringify({ branch }),
    ]) as unknown as IncomingMessage;
    (req as { method?: string }).method = "POST";
    (req as { headers?: unknown }).headers = { host: "localhost:8802" };
    return req;
  }

  it("retargets via the proxy hook and answers a same-origin url (no raw port)", async () => {
    const switched: string[] = [];
    const api = apiWithWorktreeProxy({
      activeBranch: () => undefined,
      switchTo: async (branch) => {
        switched.push(branch);
      },
    });

    const mock = mockResponse();
    await api.handle(
      postWorktree("design/hero"),
      mock.response as never,
      new URL("http://localhost:8802/api/worktrees"),
    );

    expect(switched).toEqual(["design/hero"]);
    expect(mock.status).toBe(200);
    const payload = JSON.parse(mock.body) as { branch: string; url: string };
    expect(payload.branch).toBe("design/hero");
    // The browser must stay on the stable proxy origin: a same-origin path,
    // never an absolute http://host:port URL to some instance.
    expect(payload.url).toBe("/__designbook");
    expect(mock.body).not.toMatch(/https?:\/\//);
    expect(payload).not.toHaveProperty("port");
  });

  it("surfaces switch failures as a 500 with the error message", async () => {
    const api = apiWithWorktreeProxy({
      activeBranch: () => undefined,
      switchTo: async () => {
        throw new Error("cannot retarget in --target-url (attach) mode.");
      },
    });

    const mock = mockResponse();
    await api.handle(
      postWorktree("design/hero"),
      mock.response as never,
      new URL("http://localhost:8802/api/worktrees"),
    );

    expect(mock.status).toBe(500);
    expect(JSON.parse(mock.body)).toEqual({
      error: "cannot retarget in --target-url (attach) mode.",
    });
  });

  it("host mode (no hook) returns a server-built url for the instance origin", () => {
    // Route-level host coverage would spawn a real designbook instance, so
    // the URL contract is pinned on the pure seam instead.
    expect(instanceNavigationUrl("localhost:8802", 5405)).toBe(
      "http://localhost:5405/",
    );
  });
});

describe("L3 conversation endpoints (changeset layers §Sessions & conversations)", () => {
  function post(pathname: string, body: unknown): IncomingMessage {
    const req = Readable.from([
      JSON.stringify(body),
    ]) as unknown as IncomingMessage;
    (req as { method?: string }).method = "POST";
    (req as { headers?: unknown }).headers = { host: "localhost:8802" };
    return req;
  }
  async function callPost(
    api: ReturnType<typeof createApi>,
    pathname: string,
    body: unknown,
  ): Promise<MockResponse> {
    const mock = mockResponse();
    await api.handle(
      post(pathname, body),
      mock.response as never,
      new URL(`http://localhost:8802${pathname}`),
    );
    return mock;
  }

  it("active-conversation handshake validates + clears", async () => {
    const api = apiFor();
    const set = await callPost(api, "/api/sandbox/active-conversation", {
      conversationId: "c-abc-123",
    });
    expect(set.status).toBe(200);
    expect(JSON.parse(set.body)).toEqual({ ok: true, active: "c-abc-123" });
    const cleared = await callPost(api, "/api/sandbox/active-conversation", {
      conversationId: null,
    });
    expect(JSON.parse(cleared.body)).toEqual({ ok: true, active: null });
    const bad = await callPost(api, "/api/sandbox/active-conversation", {
      conversationId: "NOT VALID!",
    });
    expect(bad.status).toBe(400);
  });

  it("GET /api/sandbox/changesets answers (allBranches included) without layers on disk", async () => {
    const api = apiFor();
    const plain = await call(api, "GET", "/api/sandbox/changesets");
    expect(plain.status).toBe(200);
    expect(JSON.parse(plain.body)).toMatchObject({ changesets: [] });
    const all = await call(api, "GET", "/api/sandbox/changesets?allBranches=1");
    expect(all.status).toBe(200);
    expect(JSON.parse(all.body)).toMatchObject({ changesets: [] });
  });

  it("i18n write with an ACTIVE conversation stages into the direct-edits layer (real file byte-clean); without one it writes real", async () => {
    const { root, configPath } = projectWithConfig(
      "export default { sets: [] };",
    );
    const localeAbs = join(root, "locales.json");
    const original = `${JSON.stringify({ title: "Hello" }, null, 2)}\n`;
    writeFileSync(localeAbs, original);
    const api = createApi({ configPath, projectRoot: root, port: 8802 });

    // No active conversation → the real write, exactly as before.
    const real = await callPost(api, "/api/i18n", {
      path: "./locales.json",
      entries: [{ key: "title", value: "Real write" }],
    });
    expect(real.status).toBe(200);
    expect(JSON.parse(real.body)).toEqual({ ok: true });
    expect(
      (JSON.parse(readFileSync(localeAbs, "utf8")) as { title: string }).title,
    ).toBe("Real write");

    // Active conversation WITHOUT git → the G1 clear error (changesets
    // require a git repository), real file untouched.
    writeFileSync(localeAbs, original);
    await callPost(api, "/api/sandbox/active-conversation", {
      conversationId: "c-route",
    });
    const nogit = await callPost(api, "/api/i18n", {
      path: "./locales.json",
      entries: [{ key: "title", value: "Staged write" }],
    });
    expect(nogit.status).toBe(400);
    expect(JSON.parse(nogit.body).error).toContain("git repository");
    expect(readFileSync(localeAbs, "utf8")).toBe(original);

    // With git → staged as a commit on the direct trunk; the real file does
    // not move.
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
      { cwd: root },
    );
    const staged = await callPost(api, "/api/i18n", {
      path: "./locales.json",
      entries: [{ key: "title", value: "Staged write" }],
    });
    expect(staged.status).toBe(200);
    expect(JSON.parse(staged.body)).toEqual({ ok: true, staged: true });
    expect(readFileSync(localeAbs, "utf8")).toBe(original);
    // The conversation's direct-edits layer carries the change.
    const meta = readFileSync(
      join(root, ".designbook/changesets/direct-c-route/meta.json"),
      "utf8",
    );
    expect(meta).toContain('"conversationId": "c-route"');
  });
});
