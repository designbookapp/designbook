/**
 * Route-level guards for branch-scoped data endpoints: with the sidecar proxy
 * retargeted to a branch worktree (`worktreeProxy.activeWorktreeRoot()` set),
 * EVERY repo-file endpoint must read/write THAT worktree — not the primary
 * checkout (the cross-branch bug: Changes tab showed "0 files" and text-tool /
 * token / flag writes landed in primary while viewing a branch).
 *
 * Same mock req/res harness as apiRoutes.test.ts (no sockets, no Pi session),
 * plus two real temp git repos standing in for the primary checkout and a
 * branch worktree. The proxy hook is a mutable `activeRoot` so one api
 * instance is exercised pre-switch (→ primary, byte-identical to host mode),
 * switched (→ worktree), and switched back.
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
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "./api.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]) {
  execFileSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args],
    { cwd, stdio: "pipe" },
  );
}

/** A committed repo with a config, a token css, a flag json, and a locale. */
function makeRepo(label: string) {
  const root = mkdtempSync(join(tmpdir(), `db-branch-scope-${label}-`));
  tempDirs.push(root);
  writeFileSync(
    join(root, "designbook.config.tsx"),
    "export default { sets: [] };",
  );
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "tokens.css"),
    `:root {\n  --primary: ${label}-color;\n}\n`,
  );
  writeFileSync(
    join(root, "src", "flags.json"),
    JSON.stringify({ newCheckout: false }, null, 2),
  );
  mkdirSync(join(root, "locales", "en"), { recursive: true });
  writeFileSync(
    join(root, "locales", "en", "app.json"),
    JSON.stringify({ title: `${label} title` }, null, 2),
  );
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

const primaryRoot = makeRepo("primary");
const worktreeRoot = makeRepo("branch");

/** Mutable switch state: undefined = primary/pre-switch, else the worktree. */
let activeRoot: string | undefined;
beforeEach(() => {
  activeRoot = undefined;
});

const api = createApi({
  configPath: join(primaryRoot, "designbook.config.tsx"),
  projectRoot: primaryRoot,
  port: 8803,
  worktreeProxy: {
    activeBranch: () => (activeRoot ? "design/hero" : undefined),
    activeWorktreeRoot: () => activeRoot,
    switchTo: async () => {},
  },
});

type MockResponse = {
  status?: number;
  body: string;
  response: {
    writeHead: (status: number) => void;
    setHeader: () => void;
    end: (chunk?: unknown) => void;
    on: () => void;
    write: () => boolean;
  };
};

function mockResponse(): MockResponse {
  const mock: MockResponse = {
    body: "",
    response: {
      writeHead(status) {
        mock.status = status;
      },
      setHeader() {},
      end(chunk) {
        if (typeof chunk === "string") mock.body += chunk;
      },
      on() {},
      write: () => true,
    },
  };
  return mock;
}

async function call(method: string, pathname: string, body?: unknown) {
  const request = (
    body === undefined
      ? { method, headers: { host: "localhost:8803" } }
      : Object.assign(Readable.from([JSON.stringify(body)]), {
          method,
          headers: { host: "localhost:8803" },
        })
  ) as IncomingMessage;
  const mock = mockResponse();
  await api.handle(
    request,
    mock.response as never,
    new URL(`http://localhost:8803${pathname}`),
  );
  return { status: mock.status, json: JSON.parse(mock.body || "null") };
}

function dirtyBranchTokens() {
  writeFileSync(
    join(worktreeRoot, "src", "tokens.css"),
    ":root {\n  --primary: branch-edited;\n}\n",
  );
}

function resetRepos() {
  git(primaryRoot, ["checkout", "-q", "--", "."]);
  git(worktreeRoot, ["checkout", "-q", "--", "."]);
}

describe("GET /api/changes (Changes tab)", () => {
  it("lists the BRANCH worktree's dirty files while switched, and primary's own status otherwise", async () => {
    resetRepos();
    dirtyBranchTokens();

    // Pre-switch: primary is clean — byte-identical to host mode.
    const before = await call("GET", "/api/changes");
    expect(before.status).toBe(200);
    expect(before.json).toEqual({ git: true, changes: [] });

    // Switched: the branch's dirty file shows (this was the "0 files" bug).
    activeRoot = worktreeRoot;
    const switched = await call("GET", "/api/changes");
    expect(switched.json.changes).toEqual([
      { path: "src/tokens.css", status: "modified", origPath: null },
    ]);

    // Switched back: primary's own (clean) status again.
    activeRoot = undefined;
    const after = await call("GET", "/api/changes");
    expect(after.json).toEqual({ git: true, changes: [] });
    resetRepos();
  });
});

describe("GET /api/file (code panel)", () => {
  it("serves the BRANCH's file content while switched", async () => {
    const primary = await call("GET", "/api/file?path=src/tokens.css");
    expect(primary.json.content).toContain("primary-color");

    activeRoot = worktreeRoot;
    const branch = await call("GET", "/api/file?path=src/tokens.css");
    expect(branch.json.content).toContain("branch-color");
  });
});

describe("GET /api/file-diff", () => {
  it("diffs against the BRANCH worktree while switched", async () => {
    resetRepos();
    dirtyBranchTokens();
    activeRoot = worktreeRoot;
    const diff = await call("GET", "/api/file-diff?path=src/tokens.css");
    expect(diff.status).toBe(200);
    expect(diff.json.status).toBe("modified");
    expect(diff.json.head).toContain("branch-color");
    expect(diff.json.working).toContain("branch-edited");
    resetRepos();
  });
});

describe("write-back endpoints land in the ACTIVE worktree", () => {
  it("POST /api/style writes the branch's css, primary untouched", async () => {
    resetRepos();
    activeRoot = worktreeRoot;
    const result = await call("POST", "/api/style", {
      path: "src/tokens.css",
      selector: ":root",
      prop: "primary",
      value: "oklch(0.7 0.1 200)",
    });
    expect(result.status).toBe(200);

    expect(readFileSync(join(worktreeRoot, "src", "tokens.css"), "utf8"))
      .toContain("oklch(0.7 0.1 200)");
    expect(readFileSync(join(primaryRoot, "src", "tokens.css"), "utf8"))
      .toContain("primary-color");
    resetRepos();
  });

  it("POST /api/json writes the branch's flag file, primary untouched", async () => {
    resetRepos();
    activeRoot = worktreeRoot;
    const result = await call("POST", "/api/json", {
      path: "src/flags.json",
      keyPath: "newCheckout",
      value: true,
    });
    expect(result.status).toBe(200);

    expect(
      JSON.parse(readFileSync(join(worktreeRoot, "src", "flags.json"), "utf8"))
        .newCheckout,
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(primaryRoot, "src", "flags.json"), "utf8"))
        .newCheckout,
    ).toBe(false);
    resetRepos();
  });

  it("POST /api/i18n resolves the config-relative locale INSIDE the branch root", async () => {
    resetRepos();
    activeRoot = worktreeRoot;
    const result = await call("POST", "/api/i18n", {
      path: "./locales/en/app.json",
      entries: [{ key: "title", value: "Branch title" }],
    });
    expect(result.status).toBe(200);

    expect(
      JSON.parse(
        readFileSync(join(worktreeRoot, "locales", "en", "app.json"), "utf8"),
      ).title,
    ).toBe("Branch title");
    expect(
      JSON.parse(
        readFileSync(join(primaryRoot, "locales", "en", "app.json"), "utf8"),
      ).title,
    ).toBe("primary title");
    resetRepos();
  });

  it("records recent-writes repo-relative to the ACTIVE root (no ../ mongrels)", async () => {
    resetRepos();
    activeRoot = worktreeRoot;
    await call("POST", "/api/style", {
      path: "src/tokens.css",
      selector: ":root",
      prop: "primary",
      value: "blue",
    });
    const recent = await call("GET", "/api/recent-writes");
    const paths = (recent.json.writes as Array<{ path: string }>).map(
      (write) => write.path,
    );
    expect(paths).toContain("src/tokens.css");
    expect(paths.every((path) => !path.startsWith(".."))).toBe(true);
    resetRepos();
  });
});

describe("POST /api/changes/discard", () => {
  it("restores the BRANCH's file while switched", async () => {
    resetRepos();
    dirtyBranchTokens();
    activeRoot = worktreeRoot;
    const result = await call("POST", "/api/changes/discard", {
      path: "src/tokens.css",
    });
    expect(result.status).toBe(200);
    expect(readFileSync(join(worktreeRoot, "src", "tokens.css"), "utf8"))
      .toContain("branch-color");
    resetRepos();
  });
});

describe("containment checks against the SAME (active) root", () => {
  it("rejects escapes from the branch root even when the target is the primary checkout", async () => {
    activeRoot = worktreeRoot;
    for (const path of [
      "../escape.css",
      join("..", "..", primaryRoot, "src", "tokens.css"),
    ]) {
      const read = await call(
        "GET",
        `/api/file?path=${encodeURIComponent(path)}`,
      );
      expect(read.status, `GET ${path}`).toBe(400);
      const write = await call("POST", "/api/style", {
        path,
        selector: ":root",
        prop: "primary",
        value: "red",
      });
      expect(write.status, `POST ${path}`).toBe(400);
    }
  });
});
