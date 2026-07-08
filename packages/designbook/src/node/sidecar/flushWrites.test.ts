import { describe, expect, it } from "vitest";
import { FLUSH_WRITES_PATH, isFlushWritesRequest } from "./flushWrites.ts";

describe("isFlushWritesRequest", () => {
  it("matches a POST to the flush-writes path", () => {
    expect(isFlushWritesRequest(FLUSH_WRITES_PATH, "POST")).toBe(true);
  });

  it("is case-insensitive on method", () => {
    expect(isFlushWritesRequest(FLUSH_WRITES_PATH, "post")).toBe(true);
  });

  it("rejects other methods", () => {
    expect(isFlushWritesRequest(FLUSH_WRITES_PATH, "GET")).toBe(false);
    expect(isFlushWritesRequest(FLUSH_WRITES_PATH, undefined)).toBe(false);
  });

  it("rejects other paths, including nested/prefixed ones", () => {
    expect(isFlushWritesRequest("/__designbook/api/recent-writes", "POST")).toBe(
      false,
    );
    expect(isFlushWritesRequest("/__designbook", "POST")).toBe(false);
    expect(isFlushWritesRequest("/__designbook/flush-writes/x", "POST")).toBe(
      false,
    );
  });
});
