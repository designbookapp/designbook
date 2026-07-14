/**
 * G4 regression — the injected-overlay staleness: sandbox-events that fire
 * while the shared SSE stream is RELEASED (hidden-tab lifecycle / transport
 * drop) are gone forever, so the store must RE-SEED from GET /api/sandbox on
 * every reconnect. Pure sync harness with fakes (no React, no EventSource).
 */

import { describe, expect, it } from "vitest";
import { startSandboxStoreSync } from "./sandboxStoreSync";
import type {
  SandboxEvent,
  SandboxStatusPayload,
  SandboxStore,
} from "./sandboxModel";

function pinPayload(ids: string[]): SandboxStatusPayload {
  return {
    pins: ids.map((id) => ({
      id,
      createdAt: 1,
      target: { file: "src/Card.tsx", exportName: "Card", name: "Card" },
    })),
  };
}

function harness(initial: SandboxStatusPayload) {
  let payload = initial;
  let fetches = 0;
  let store: SandboxStore = {
    pins: {},
    changesets: [],
    switches: {},
    bakes: {},
    rebases: {},
    conflicts: [],
    dataConflicts: [],
  };
  let emitEvent: ((event: SandboxEvent) => void) | undefined;
  let emitStatus: ((status: "open" | "error") => void) | undefined;
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const dispose = startSandboxStoreSync({
    fetchStatus: async () => {
      fetches += 1;
      return payload;
    },
    subscribeEvents: (handler) => {
      emitEvent = handler;
      return () => {
        emitEvent = undefined;
      };
    },
    subscribeStatus: (handler) => {
      emitStatus = handler;
      return () => {
        emitStatus = undefined;
      };
    },
    onStore: (update) => {
      store = update(store);
    },
  });
  return {
    dispose,
    flush,
    getStore: () => store,
    getFetches: () => fetches,
    setPayload: (next: SandboxStatusPayload) => {
      payload = next;
    },
    event: (event: SandboxEvent) => emitEvent?.(event),
    status: (status: "open" | "error") => emitStatus?.(status),
  };
}

describe("sandbox store sync (G4 staleness regression)", () => {
  it("seeds once, folds live events, and does NOT refetch on the first open", async () => {
    const h = harness(pinPayload(["p1"]));
    await h.flush();
    expect(Object.keys(h.getStore().pins)).toEqual(["p1"]);
    expect(h.getFetches()).toBe(1);
    h.status("open"); // The mount-time connect — no reconnect refetch.
    await h.flush();
    expect(h.getFetches()).toBe(1);
    // Live fold still works.
    h.event({ type: "thread", pinId: "p1", message: { role: "user", text: "x", at: 5 } });
    expect(h.getStore().pins.p1.thread).toHaveLength(1);
    h.dispose();
  });

  it("re-seeds on RECONNECT — state that changed while the stream was down appears without a reload", async () => {
    const h = harness(pinPayload(["p1"]));
    await h.flush();
    h.status("open");
    await h.flush();
    expect(Object.keys(h.getStore().pins)).toEqual(["p1"]);

    // Stream released (hidden tab) → a pin lands server-side; its events
    // are never delivered. The stale client only hears the reconnect.
    h.status("error");
    h.setPayload(pinPayload(["p1", "p2-created-while-hidden"]));
    h.status("open");
    await h.flush();
    expect(h.getFetches()).toBe(2);
    expect(Object.keys(h.getStore().pins)).toEqual([
      "p1",
      "p2-created-while-hidden",
    ]);
    h.dispose();
  });

  it("carries transient bake/rebase progress across the re-seed", async () => {
    const h = harness(pinPayload(["p1"]));
    await h.flush();
    h.status("open");
    h.event({
      type: "bake-status",
      changesetId: "cs-1",
      pinId: "p1",
      status: "running",
    });
    expect(h.getStore().bakes["cs-1"]?.status).toBe("running");
    h.status("open"); // Reconnect.
    await h.flush();
    // Pins re-seeded, transient progress preserved.
    expect(h.getStore().bakes["cs-1"]?.status).toBe("running");
    h.dispose();
  });

  it("stops folding and fetching after dispose", async () => {
    const h = harness(pinPayload(["p1"]));
    await h.flush();
    h.status("open");
    h.dispose();
    h.status("open");
    await h.flush();
    expect(h.getFetches()).toBe(1);
  });
});
