import { describe, expect, it } from "vitest";
import {
  CROSS_ORIGIN_EXEMPT_API_PATHS,
  isCrossOriginExemptApiPath,
  isNonLoopbackBindHost,
  isSameOriginApiRequest,
} from "./apiOrigin.ts";

describe("isSameOriginApiRequest — host mode (loopback bind)", () => {
  const boundHost = "localhost";
  const boundPort = 8787;

  it("passes same-origin requests", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://localhost:8787",
        host: "localhost:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(true);
  });

  it("passes requests with no Origin header (curl, server-to-server, same-origin nav)", () => {
    expect(
      isSameOriginApiRequest({
        origin: undefined,
        host: "localhost:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(true);
  });

  it("rejects a foreign Origin", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://evil.com",
        host: "localhost:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(false);
  });

  it("treats localhost/127.0.0.1/[::1] as equivalent", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://127.0.0.1:8787",
        host: "localhost:8787",
        boundHost: "localhost",
        boundPort,
      }),
    ).toBe(true);
    expect(
      isSameOriginApiRequest({
        origin: "http://[::1]:8787",
        host: "127.0.0.1:8787",
        boundHost: "127.0.0.1",
        boundPort,
      }),
    ).toBe(true);
  });

  it("treats an unspecified boundHost as loopback", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://localhost:8787",
        host: "localhost:8787",
        boundHost: undefined,
        boundPort,
      }),
    ).toBe(true);
  });

  it("rejects a mismatched port even for an otherwise-loopback origin", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://localhost:9999",
        host: "localhost:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(false);
  });

  it("rejects a DNS-rebinding Host header even with no Origin", () => {
    expect(
      isSameOriginApiRequest({
        origin: undefined,
        host: "evil.com",
        boundHost,
        boundPort,
      }),
    ).toBe(false);
  });

  it("rejects a spoofed Host header alongside a matching-looking Origin", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://localhost:8787",
        host: "evil.com:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(false);
  });
});

describe("isSameOriginApiRequest — LAN mode (wildcard bind)", () => {
  const boundHost = "0.0.0.0";
  const boundPort = 8787;

  it("passes a same-origin request addressed to the LAN IP", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://192.168.1.20:8787",
        host: "192.168.1.20:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(true);
  });

  it("passes a same-origin request over localhost too (LAN bind still answers loopback)", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://localhost:8787",
        host: "localhost:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(true);
  });

  it("passes requests with no Origin header", () => {
    expect(
      isSameOriginApiRequest({
        origin: undefined,
        host: "192.168.1.20:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(true);
  });

  it("rejects a foreign Origin whose declared host doesn't match the request's Host", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://evil.com",
        host: "192.168.1.20:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(false);
  });

  it("rejects a mismatched port", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://192.168.1.20:9999",
        host: "192.168.1.20:8787",
        boundHost,
        boundPort,
      }),
    ).toBe(false);
  });
});

describe("isSameOriginApiRequest — explicit non-loopback bind", () => {
  it("passes an Origin matching the explicit bind host", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://192.168.1.20:8787",
        host: "192.168.1.20:8787",
        boundHost: "192.168.1.20",
        boundPort: 8787,
      }),
    ).toBe(true);
  });

  it("rejects an Origin not matching the explicit bind host", () => {
    expect(
      isSameOriginApiRequest({
        origin: "http://evil.com:8787",
        host: "192.168.1.20:8787",
        boundHost: "192.168.1.20",
        boundPort: 8787,
      }),
    ).toBe(false);
  });
});

describe("isCrossOriginExemptApiPath", () => {
  it("exempts exactly the discovery route and its legacy figma alias (E1)", () => {
    expect([...CROSS_ORIGIN_EXEMPT_API_PATHS].sort()).toEqual([
      "/api/figma-hello",
      "/api/hello",
    ]);
    expect(isCrossOriginExemptApiPath("/api/hello")).toBe(true);
    expect(isCrossOriginExemptApiPath("/api/figma-hello")).toBe(true);
  });

  it("exempts nothing else — integrations cannot add exemptions", () => {
    for (const path of [
      "/api/x/figma/status",
      "/api/figma/status",
      "/api/bridge/figma",
      "/api/prompt",
      "/api/hello/extra",
    ]) {
      expect(isCrossOriginExemptApiPath(path), path).toBe(false);
    }
  });
});

describe("isNonLoopbackBindHost", () => {
  it("treats undefined, localhost, 127.0.0.1, and ::1 as loopback", () => {
    expect(isNonLoopbackBindHost(undefined)).toBe(false);
    expect(isNonLoopbackBindHost("localhost")).toBe(false);
    expect(isNonLoopbackBindHost("127.0.0.1")).toBe(false);
    expect(isNonLoopbackBindHost("::1")).toBe(false);
  });

  it("treats 0.0.0.0, ::, and LAN IPs as non-loopback", () => {
    expect(isNonLoopbackBindHost("0.0.0.0")).toBe(true);
    expect(isNonLoopbackBindHost("::")).toBe(true);
    expect(isNonLoopbackBindHost("192.168.1.20")).toBe(true);
  });
});
