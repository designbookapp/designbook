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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
