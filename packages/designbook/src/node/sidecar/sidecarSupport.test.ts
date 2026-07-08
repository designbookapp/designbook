import { describe, expect, it } from "vitest";
import {
  classifyDirectApiPath,
  classifyProxyPath,
  deepLinkBootstrapHtml,
  escapeHtml,
  parseTargetPort,
  recoveryPageHtml,
  RESTART_BACKOFF_MS,
  restartDelayMs,
  stripDesignbookNamespace,
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
