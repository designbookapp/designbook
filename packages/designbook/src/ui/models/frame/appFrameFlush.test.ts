import { describe, expect, it, vi } from "vitest";
import { FLUSH_WRITES_PATH, flushWrites } from "@designbook-ui/models/frame/appFrameFlush";

describe("flushWrites", () => {
  it("POSTs to the flush-writes path and resolves on success", async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await flushWrites(2000, doFetch);
    expect(doFetch).toHaveBeenCalledWith(
      FLUSH_WRITES_PATH,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("never rejects when the fetch itself throws (unreachable server)", async () => {
    const doFetch = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(flushWrites(2000, doFetch)).resolves.toBeUndefined();
  });

  it("resolves even when the fetch never settles, bounded by the timeout", async () => {
    vi.useFakeTimers();
    try {
      const doFetch = vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const promise = flushWrites(50, doFetch as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(60);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an AbortSignal that fires after timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const doFetch = vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            capturedSignal = init?.signal;
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const promise = flushWrites(100, doFetch as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(150);
      await promise;
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
