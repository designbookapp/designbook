import { describe, expect, it } from "vitest";
import {
  classifyDirectApiPath,
  classifyProxyPath,
  deepLinkBootstrapHtml,
  escapeHtml,
  MAX_WARM_TARGET_SERVERS,
  parseTargetPort,
  recoveryPageHtml,
  RESTART_BACKOFF_MS,
  restartDelayMs,
  selectTargetEvictions,
  spawnImmediatelyOnRetarget,
  stripDesignbookNamespace,
  worktreeTargetCwd,
} from "./sidecarSupport.ts";

describe("parseTargetPort", () => {
  it("parses the Vite Local URL line", () => {
    expect(parseTargetPort("  ➜  Local:   http://localhost:3012/")).toBe(3012);
  });

  it("parses through ANSI color codes", () => {
    expect(
      parseTargetPort("[32m  ➜  Local:[39m http://localhost:5173/"),
    ).toBe(5173);
  });

  it("parses 127.0.0.1 and [::1]", () => {
    expect(parseTargetPort("Local: http://127.0.0.1:4000/")).toBe(4000);
    expect(parseTargetPort("Network: http://[::1]:8080/")).toBe(8080);
  });

  it("returns undefined for lines without a localhost url", () => {
    expect(parseTargetPort("VITE v5.0 ready in 300 ms")).toBeUndefined();
    expect(parseTargetPort("error: something http://example.com:80/")).toBeUndefined();
  });
});

describe("classifyProxyPath (/api collision fix)", () => {
  it("forwards the app's own /api/* to the target (NOT designbook)", () => {
    expect(classifyProxyPath("/api/health")).toBe("forward");
    expect(classifyProxyPath("/api/state")).toBe("forward");
    expect(classifyProxyPath("/api/")).toBe("forward");
  });
  it("serves designbook's api only under the /__designbook namespace", () => {
    expect(classifyProxyPath("/__designbook/api/state")).toBe("db-api");
    expect(classifyProxyPath("/__designbook/api/target/retarget")).toBe(
      "db-api",
    );
    expect(classifyProxyPath("/__designbook/api/events")).toBe("db-api");
  });
  it("routes the health probe and deep-link bootstrap", () => {
    expect(classifyProxyPath("/__designbook/ping")).toBe("ping");
    expect(classifyProxyPath("/__designbook")).toBe("deeplink");
    expect(classifyProxyPath("/__designbook/component/primitives.Card")).toBe(
      "deeplink",
    );
  });
  it("forwards ordinary app routes", () => {
    expect(classifyProxyPath("/")).toBe("forward");
    expect(classifyProxyPath("/src/main.tsx")).toBe("forward");
    expect(classifyProxyPath("/@vite/client")).toBe("forward");
  });
});

describe("classifyDirectApiPath (direct port keeps plain /api/*)", () => {
  it("serves plain /api/* as designbook's", () => {
    expect(classifyDirectApiPath("/api/state")).toBe("db-api");
  });
  it("also accepts the namespaced form (stripped)", () => {
    expect(classifyDirectApiPath("/__designbook/api/state")).toBe(
      "db-api-stripped",
    );
  });
  it("404s anything else (no app is served here)", () => {
    expect(classifyDirectApiPath("/")).toBe("not-found");
    expect(classifyDirectApiPath("/index.html")).toBe("not-found");
  });
});

describe("stripDesignbookNamespace", () => {
  it("strips the /__designbook prefix, preserving path + query", () => {
    expect(stripDesignbookNamespace("/__designbook/api/state")).toBe(
      "/api/state",
    );
    expect(
      stripDesignbookNamespace("/__designbook/api/file?path=a/b.tsx"),
    ).toBe("/api/file?path=a/b.tsx");
  });
  it("leaves non-namespaced urls unchanged", () => {
    expect(stripDesignbookNamespace("/api/state")).toBe("/api/state");
  });
  it("maps a bare /__designbook to /", () => {
    expect(stripDesignbookNamespace("/__designbook")).toBe("/");
  });
});

describe("restartDelayMs (escalating backoff, 30s cap)", () => {
  it("follows 1s → 2s → 5s → 10s → 30s then holds at 30s", () => {
    expect(RESTART_BACKOFF_MS).toEqual([1000, 2000, 5000, 10000, 30000]);
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(restartDelayMs)).toEqual([
      1000, 2000, 5000, 10000, 30000, 30000, 30000, 30000,
    ]);
  });
});

describe("escapeHtml", () => {
  it("escapes the dangerous characters", () => {
    expect(escapeHtml(`<script>"'&`)).toBe(
      "&lt;script&gt;&quot;&#39;&amp;",
    );
  });
});

describe("recoveryPageHtml", () => {
  it("escapes error and log content (no raw injection)", () => {
    const html = recoveryPageHtml({
      error: "boom <img src=x onerror=alert(1)>",
      logLines: ["line one </pre><script>evil()</script>", "line two"],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("</pre><script>evil()");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("line two");
  });

  it("wires the recovery affordances under the /__designbook namespace", () => {
    const html = recoveryPageHtml({ error: "down", logLines: [] });
    expect(html).toContain("/__designbook/ping");
    expect(html).toContain("/__designbook/api/events");
    expect(html).toContain("/__designbook/api/prompt");
    expect(html).toContain("/__designbook/api/abort");
    // The app's own /api must NOT be shadowed by the recovery page.
    expect(html).not.toContain('EventSource("/api/events")');
    expect(html).toContain("(no output captured)");
  });
});

describe("deepLinkBootstrapHtml", () => {
  it("sets autoExpand and redirects with no entry", () => {
    const html = deepLinkBootstrapHtml();
    expect(html).toContain("designbook:autoExpand");
    expect(html).not.toContain("designbook:deepLink");
    expect(html).toContain('location.replace("/")');
  });

  it("sets the deep link when an entry id is given", () => {
    const html = deepLinkBootstrapHtml("primitives.Island");
    expect(html).toContain("designbook:deepLink");
    expect(html).toContain("primitives.Island");
  });

  it("encodes the entry id injection-safely (no </script> breakout)", () => {
    const html = deepLinkBootstrapHtml('a"</script><b>');
    // The literal must not contain a real closing script tag.
    expect(html).not.toContain("</script><b>");
    // `<` is unicode-escaped so the browser can't end the <script> early.
    expect(html).toContain("\\u003c/script");
    // Exactly one real </script> (the closing tag of the bootstrap script).
    expect(html.match(/<\/script>/g)?.length).toBe(1);
  });
});

describe("worktreeTargetCwd (branch-switch retarget dir)", () => {
  it("maps a monorepo app package into the worktree", () => {
    expect(
      worktreeTargetCwd("/repo", "/repo/examples/demo", "/wt/feature-x"),
    ).toBe("/wt/feature-x/examples/demo");
  });

  it("uses the worktree root when the target cwd IS the repo root", () => {
    expect(worktreeTargetCwd("/repo", "/repo", "/wt/feature-x")).toBe(
      "/wt/feature-x",
    );
  });

  it("switching back to the primary checkout maps to the original cwd", () => {
    // prepareWorktree resolves the primary branch to the projectRoot checkout
    // itself, so the mapping must be the identity.
    expect(worktreeTargetCwd("/repo", "/repo/examples/demo", "/repo")).toBe(
      "/repo/examples/demo",
    );
  });

  it("leaves a target cwd outside the repo untouched", () => {
    expect(worktreeTargetCwd("/repo", "/elsewhere/app", "/wt/feature-x")).toBe(
      "/elsewhere/app",
    );
  });
});

describe("selectTargetEvictions (warm dev-server LRU, per-branch-sessions)", () => {
  const entry = (key: string, lastUsedAt: number) => ({ key, lastUsedAt });

  it("keeps everything under the cap", () => {
    expect(
      selectTargetEvictions(
        [entry("a", 1), entry("b", 2), entry("c", 3)],
        "c",
        MAX_WARM_TARGET_SERVERS,
      ),
    ).toEqual([]);
  });

  it("evicts the least-recently-viewed beyond the cap", () => {
    expect(
      selectTargetEvictions(
        [entry("a", 1), entry("b", 2), entry("c", 3), entry("d", 4)],
        "d",
        3,
      ),
    ).toEqual(["a"]);
  });

  it("never evicts the currently-viewed entry, even when it is the LRU", () => {
    expect(
      selectTargetEvictions(
        [entry("active", 1), entry("b", 2), entry("c", 3), entry("d", 4)],
        "active",
        3,
      ),
    ).toEqual(["b"]);
  });

  it("evicts in LRU order when multiple must go", () => {
    expect(
      selectTargetEvictions(
        [entry("a", 3), entry("b", 1), entry("c", 2), entry("d", 4)],
        "d",
        2,
      ),
    ).toEqual(["b", "c"]);
  });

  it("forced --target-port degrades to a single server (cap 1)", () => {
    expect(
      selectTargetEvictions([entry("old", 1), entry("new", 2)], "new", 1),
    ).toEqual(["old"]);
  });

  it("clamps a nonsensical cap to at least the active server", () => {
    expect(
      selectTargetEvictions([entry("a", 1), entry("b", 2)], "b", 0),
    ).toEqual(["a"]);
  });

  it("documents the cap constant", () => {
    expect(MAX_WARM_TARGET_SERVERS).toBe(3);
  });
});

describe("spawnImmediatelyOnRetarget (forced-port stop-then-spawn ordering)", () => {
  it("forced port + an eviction: the spawn must WAIT for the evictee's exit", () => {
    // The evicted server still owns the one shared port; spawning now would
    // make a --strictPort dev server exit instantly.
    expect(spawnImmediatelyOnRetarget(true, 1)).toBe(false);
  });

  it("forced port with nothing evicted (first target): spawn now", () => {
    expect(spawnImmediatelyOnRetarget(true, 0)).toBe(true);
  });

  it("auto-port mode always spawns immediately (each server has its own port)", () => {
    expect(spawnImmediatelyOnRetarget(false, 0)).toBe(true);
    expect(spawnImmediatelyOnRetarget(false, 1)).toBe(true);
  });
});
