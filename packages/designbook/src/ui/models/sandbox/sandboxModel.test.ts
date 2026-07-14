/**
 * Sandbox model tests: event folds (the canvas's progressive landing), the
 * status → state reconstruction (reload, D4), and derived views.
 */

import { describe, expect, it } from "vitest";
import {
  activePins,
  appendSandboxActivity,
  applySandboxEvent,
  clampFrameSize,
  pinLastActivity,
  pinStatus,
  pinThreadTitle,
  pinsFromStatus,
  readyCounts,
  resolveFrameSize,
  sandboxModuleUrl,
  activeChangesetCount,
  activeChangesetForPin,
  applySandboxStoreEvent,
  bakeStateForPin,
  conflictForPin,
  conflictedPinIds,
  inPlaceVariantId,
  sameExportConflicts,
  sandboxComponentKey,
  sandboxEventMatchesBranch,
  sandboxOverridesActive,
  storeFromStatus,
  type SandboxState,
  type SandboxStore,
} from "./sandboxModel";

const WIRE_PIN = {
  id: "card-x1",
  createdAt: 5,
  target: { file: "src/Card.tsx", exportName: "ProductCard", name: "Card" },
  resolved: false,
  busy: false,
  thread: [{ role: "user", text: "hi", at: 1 }],
  wrapperAbsPath: "/repo/.designbook/sandbox/card-x1/wrapper.tsx",
  variants: [
    {
      id: "compact",
      intent: "denser",
      file: ".designbook/sandbox/card-x1/compact.tsx",
      absPath: "/repo/.designbook/sandbox/card-x1/compact.tsx",
      x: 24,
      y: 24,
      status: "ready",
      rev: 1,
    },
  ],
};

describe("pinsFromStatus", () => {
  it("maps the wire payload, dropping malformed rows", () => {
    const state = pinsFromStatus({
      pins: [WIRE_PIN, { id: "broken" } as never],
    });
    expect(Object.keys(state)).toEqual(["card-x1"]);
    expect(state["card-x1"].variants[0]).toMatchObject({
      id: "compact",
      status: "ready",
      x: 24,
    });
    expect(state["card-x1"].thread).toEqual([
      { role: "user", text: "hi", at: 1 },
    ]);
  });

  it("U5: parses the persisted locator (element re-resolution); garbage dropped", () => {
    const state = pinsFromStatus({
      pins: [
        {
          ...WIRE_PIN,
          locator: {
            tag: "section",
            textHash: "ab12",
            childIndexPath: [0, 2, "x" as never],
            text: "Ceramic Vase",
            className: "card",
          },
        },
        { ...WIRE_PIN, id: "card-x2", locator: { tag: "" } },
        { ...WIRE_PIN, id: "card-x3" },
      ],
    });
    expect(state["card-x1"].locator).toEqual({
      tag: "section",
      textHash: "ab12",
      childIndexPath: [0, 2],
      text: "Ceramic Vase",
      className: "card",
    });
    expect(state["card-x2"].locator).toBeUndefined();
    expect(state["card-x3"].locator).toBeUndefined();
  });

  it("kind compat: absent kind = component; element pins keep the controller path", () => {
    const state = pinsFromStatus({
      pins: [
        WIRE_PIN, // pre-v2 wire shape — no kind
        {
          ...WIRE_PIN,
          id: "card-e1",
          kind: "element",
          controllerAbsPath: "/repo/.designbook/sandbox/card-e1/controller.tsx",
        },
      ],
    });
    expect(state["card-x1"].kind).toBe("component");
    expect(state["card-x1"].controllerAbsPath).toBeUndefined();
    expect(state["card-e1"].kind).toBe("element");
    expect(state["card-e1"].controllerAbsPath).toBe(
      "/repo/.designbook/sandbox/card-e1/controller.tsx",
    );
  });
});

describe("frame sizing (auto-size + user-resize)", () => {
  it("maps persisted w/h off the wire; absent = auto-size (old entries)", () => {
    const state = pinsFromStatus({
      pins: [
        {
          ...WIRE_PIN,
          variants: [
            { ...WIRE_PIN.variants[0], id: "sized", w: 500, h: 360 },
            // Old entry — no w/h at all → auto-size.
            { ...WIRE_PIN.variants[0], id: "auto" },
            // Garbage/non-positive dims are dropped (auto).
            { ...WIRE_PIN.variants[0], id: "bad", w: 0, h: -5 },
          ],
        },
      ],
    });
    const byId = Object.fromEntries(
      state["card-x1"].variants.map((variant) => [variant.id, variant]),
    );
    expect(byId.sized.w).toBe(500);
    expect(byId.sized.h).toBe(360);
    expect(byId.auto.w).toBeUndefined();
    expect(byId.auto.h).toBeUndefined();
    expect(byId.bad.w).toBeUndefined();
    expect(byId.bad.h).toBeUndefined();
  });

  it("clampFrameSize bounds + rounds; NaN floors to the minimum", () => {
    expect(clampFrameSize(500.4, 360.6)).toEqual({ w: 500, h: 361 });
    expect(clampFrameSize(10, 10)).toEqual({ w: 200, h: 120 });
    expect(clampFrameSize(9999, 9999)).toEqual({ w: 2000, h: 2000 });
    expect(clampFrameSize(NaN, NaN)).toEqual({ w: 200, h: 120 });
  });

  it("resolveFrameSize folds echo over the record; null = reset to auto", () => {
    const variant = { w: 500, h: 360 };
    // Live echo wins.
    expect(resolveFrameSize({ w: 300, h: 200 }, variant)).toEqual({
      w: 300,
      h: 200,
    });
    // Explicit reset echo beats a still-persisted size.
    expect(resolveFrameSize(null, variant)).toBeUndefined();
    // No echo → the persisted size.
    expect(resolveFrameSize(undefined, variant)).toEqual({ w: 500, h: 360 });
    // No echo, no persisted size → auto (undefined).
    expect(resolveFrameSize(undefined, {})).toBeUndefined();
  });
});

function seeded(): SandboxState {
  return applySandboxEvent({}, {
    type: "pin-created",
    pinId: "card-x1",
    pin: { ...WIRE_PIN, variants: [], thread: [] },
  });
}

describe("applySandboxEvent", () => {
  it("folds the pin lifecycle: created → planned → ready/failed → complete", () => {
    let state = seeded();
    expect(state["card-x1"]).toBeDefined();

    state = applySandboxEvent(state, {
      type: "director-started",
      pinId: "card-x1",
    });
    expect(state["card-x1"].planning).toBe(true);

    state = applySandboxEvent(state, {
      type: "variants-planned",
      pinId: "card-x1",
      variants: [
        { id: "compact", intent: "denser", file: "a.tsx", x: 24, y: 24 },
        { id: "bold", intent: "louder", file: "b.tsx", x: 384, y: 24 },
      ],
    });
    expect(state["card-x1"].planning).toBe(false);
    expect(state["card-x1"].variants.map((v) => v.status)).toEqual([
      "generating",
      "generating",
    ]);

    state = applySandboxEvent(state, {
      type: "variant-ready",
      pinId: "card-x1",
      variantId: "compact",
      absPath: "/repo/a.tsx",
      wrapperAbsPath: "/repo/w.tsx",
      controllerAbsPath: "/repo/c.tsx",
      rev: 1,
    });
    state = applySandboxEvent(state, {
      type: "variant-failed",
      pinId: "card-x1",
      variantId: "bold",
      error: "quota",
    });
    state = applySandboxEvent(state, { type: "run-complete", pinId: "card-x1" });
    const pin = state["card-x1"];
    expect(pin.busy).toBe(false);
    expect(pin.wrapperAbsPath).toBe("/repo/w.tsx");
    // Element pins' controller path folds in with the landing (v2).
    expect(pin.controllerAbsPath).toBe("/repo/c.tsx");
    expect(pin.variants.find((v) => v.id === "compact")).toMatchObject({
      status: "ready",
      absPath: "/repo/a.tsx",
      rev: 1,
    });
    expect(pin.variants.find((v) => v.id === "bold")).toMatchObject({
      status: "failed",
      error: "quota",
    });
    expect(readyCounts(pin)).toEqual({ ready: 1, total: 2 });
  });

  it("folds variant-retrying: failed card returns to generating, pin busy", () => {
    let state = seeded();
    state = applySandboxEvent(state, {
      type: "variants-planned",
      pinId: "card-x1",
      variants: [{ id: "compact", intent: "denser", file: "a.tsx", x: 24, y: 24 }],
    });
    state = applySandboxEvent(state, {
      type: "variant-failed",
      pinId: "card-x1",
      variantId: "compact",
      error: "stream ended",
    });
    state = applySandboxEvent(state, { type: "run-complete", pinId: "card-x1" });
    expect(state["card-x1"].busy).toBe(false);

    state = applySandboxEvent(state, {
      type: "variant-retrying",
      pinId: "card-x1",
      variantId: "compact",
      attempt: 1,
    });
    expect(state["card-x1"].busy).toBe(true);
    expect(state["card-x1"].variants[0]).toMatchObject({
      status: "generating",
      error: undefined,
    });
  });

  it("folds iterate: updating → updated bumps rev", () => {
    let state = pinsFromStatus({ pins: [WIRE_PIN] });
    state = applySandboxEvent(state, {
      type: "variant-updating",
      pinId: "card-x1",
      variantId: "compact",
    });
    expect(state["card-x1"].variants[0].status).toBe("updating");
    expect(state["card-x1"].busy).toBe(true);
    state = applySandboxEvent(state, {
      type: "variant-updated",
      pinId: "card-x1",
      variantId: "compact",
      absPath: "/repo/a.tsx",
      rev: 2,
    });
    expect(state["card-x1"].variants[0]).toMatchObject({
      status: "ready",
      rev: 2,
    });
    expect(state["card-x1"].busy).toBe(false);
  });

  it("folds replace: failed surfaces the reason; success resolves (D3)", () => {
    let state = pinsFromStatus({ pins: [WIRE_PIN] });
    state = applySandboxEvent(state, {
      type: "replace-started",
      pinId: "card-x1",
    });
    expect(state["card-x1"].busy).toBe(true);
    state = applySandboxEvent(state, {
      type: "replace-failed",
      pinId: "card-x1",
      error: "typecheck failed",
    });
    expect(state["card-x1"].resolved).toBe(false);
    expect(state["card-x1"].lastError).toContain("typecheck");
    state = applySandboxEvent(state, { type: "replaced", pinId: "card-x1" });
    expect(state["card-x1"].resolved).toBe(true);
    // Resolved pins leave the active views (kept as history).
    expect(activePins(state)).toEqual([]);
  });

  it("UX v3 folds: intent-routed + pin-title; a new user prompt clears routing", () => {
    let state = seeded();
    state = applySandboxEvent(state, {
      type: "intent-routed",
      pinId: "card-x1",
      intent: "variants",
      n: 3,
    });
    expect(state["card-x1"].routedIntent).toEqual({ intent: "variants", n: 3 });
    expect(state["card-x1"].busy).toBe(true);
    // The NEXT user prompt hasn't been routed yet.
    state = applySandboxEvent(state, {
      type: "thread",
      pinId: "card-x1",
      message: { role: "user", text: "again", at: 10 },
    });
    expect(state["card-x1"].routedIntent).toBeUndefined();
    state = applySandboxEvent(state, {
      type: "intent-routed",
      pinId: "card-x1",
      intent: "turn",
    });
    expect(state["card-x1"].routedIntent).toEqual({ intent: "turn" });
    // Titles land by event and off the status payload alike.
    state = applySandboxEvent(state, {
      type: "pin-title",
      pinId: "card-x1",
      title: "Denser card",
    });
    expect(state["card-x1"].title).toBe("Denser card");
    const restored = pinsFromStatus({
      pins: [{ ...WIRE_PIN, title: "Denser card" }],
    });
    expect(restored["card-x1"].title).toBe("Denser card");
    // Pre-v3 payloads (no title) keep the fallback path.
    expect(pinsFromStatus({ pins: [WIRE_PIN] })["card-x1"].title).toBeUndefined();
  });

  it("U4: session-activity folds into director/variant activity, keyed by role", () => {
    let state = seeded();
    state = applySandboxEvent(state, {
      type: "director-started",
      pinId: "card-x1",
    });
    state = applySandboxEvent(state, {
      type: "session-activity",
      pinId: "card-x1",
      sessionRole: "director",
      entry: { kind: "thinking", text: "Reading the card " },
    });
    state = applySandboxEvent(state, {
      type: "session-activity",
      pinId: "card-x1",
      sessionRole: "director",
      entry: { kind: "thinking", text: "source…" },
    });
    // Consecutive thinking deltas EXTEND one entry (coalesced stream).
    expect(state["card-x1"].directorActivity).toEqual([
      { type: "thinking", text: "Reading the card source…" },
    ]);
    // Tool start→end upserts by id (running → done), keeping the detail.
    state = applySandboxEvent(state, {
      type: "session-activity",
      pinId: "card-x1",
      sessionRole: "director",
      entry: { kind: "tool", id: "t1", name: "read", status: "running", detail: "Card.tsx" },
    });
    state = applySandboxEvent(state, {
      type: "session-activity",
      pinId: "card-x1",
      sessionRole: "director",
      entry: { kind: "tool", id: "t1", name: "read", status: "done" },
    });
    expect(state["card-x1"].directorActivity[1]).toEqual({
      type: "tool",
      id: "t1",
      name: "read",
      status: "done",
      detail: "Card.tsx",
    });

    // Variant-keyed activity lands on THAT variant only.
    state = applySandboxEvent(state, {
      type: "variants-planned",
      pinId: "card-x1",
      variants: [
        { id: "compact", intent: "denser", file: "a.tsx", x: 0, y: 0 },
        { id: "bold", intent: "louder", file: "b.tsx", x: 0, y: 0 },
      ],
    });
    state = applySandboxEvent(state, {
      type: "session-activity",
      pinId: "card-x1",
      sessionRole: "variant",
      variantId: "compact",
      entry: { kind: "thinking", text: "Tightening spacing" },
    });
    expect(
      state["card-x1"].variants.find((v) => v.id === "compact")?.activity,
    ).toEqual([{ type: "thinking", text: "Tightening spacing" }]);
    expect(
      state["card-x1"].variants.find((v) => v.id === "bold")?.activity,
    ).toEqual([]);

    // Malformed/unaddressed payloads are no-ops.
    expect(
      applySandboxEvent(state, {
        type: "session-activity",
        pinId: "card-x1",
        sessionRole: "variant",
        entry: { kind: "thinking", text: "no variant id" },
      }),
    ).toBe(state);
    expect(
      applySandboxEvent(state, {
        type: "session-activity",
        pinId: "card-x1",
        sessionRole: "director",
        entry: { kind: "mystery" },
      }),
    ).toBe(state);

    // A NEW director run resets the transparency rows.
    state = applySandboxEvent(state, {
      type: "director-started",
      pinId: "card-x1",
    });
    expect(state["card-x1"].directorActivity).toEqual([]);
  });

  it("U4: variant-retrying resets that variant's activity + tracks attempt; landing clears it", () => {
    let state = seeded();
    state = applySandboxEvent(state, {
      type: "variants-planned",
      pinId: "card-x1",
      variants: [{ id: "compact", intent: "denser", file: "a.tsx", x: 0, y: 0 }],
    });
    state = applySandboxEvent(state, {
      type: "session-activity",
      pinId: "card-x1",
      sessionRole: "variant",
      variantId: "compact",
      entry: { kind: "thinking", text: "first attempt" },
    });
    state = applySandboxEvent(state, {
      type: "variant-retrying",
      pinId: "card-x1",
      variantId: "compact",
      attempt: 2,
    });
    expect(state["card-x1"].variants[0]).toMatchObject({
      status: "generating",
      activity: [],
      attempt: 2,
    });
    state = applySandboxEvent(state, {
      type: "variant-ready",
      pinId: "card-x1",
      variantId: "compact",
      absPath: "/repo/a.tsx",
      rev: 1,
    });
    expect(state["card-x1"].variants[0].attempt).toBeUndefined();
  });

  it("appendSandboxActivity caps the list, dropping oldest entries", () => {
    let entries = [] as ReturnType<typeof appendSandboxActivity>;
    for (let i = 0; i < 150; i += 1) {
      entries = appendSandboxActivity(entries, {
        type: "tool",
        id: `t${i}`,
        name: "read",
        status: "done",
      });
    }
    expect(entries.length).toBe(120);
    expect(entries[0]).toMatchObject({ id: "t30" });
  });

  it("thread events append and unknown events are no-ops", () => {
    let state = seeded();
    state = applySandboxEvent(state, {
      type: "thread",
      pinId: "card-x1",
      message: { role: "assistant", text: "done", at: 9 },
    });
    expect(state["card-x1"].thread).toEqual([
      { role: "assistant", text: "done", at: 9 },
    ]);
    expect(applySandboxEvent(state, { type: "mystery", pinId: "card-x1" })).toBe(
      state,
    );
    expect(applySandboxEvent(state, { type: "thread" })).toBe(state);
  });
});

describe("derived views", () => {
  it("pinStatus reflects the lifecycle", () => {
    const state = pinsFromStatus({ pins: [WIRE_PIN] });
    expect(pinStatus(state["card-x1"])).toBe("ready");
    const generating = applySandboxEvent(state, {
      type: "variants-planned",
      pinId: "card-x1",
      variants: [{ id: "new", intent: "", file: "n.tsx", x: 0, y: 0 }],
    });
    expect(pinStatus(generating["card-x1"])).toBe("generating");
  });

  it("sandboxModuleUrl builds /@fs/ URLs with the rev cache-bust", () => {
    expect(sandboxModuleUrl("/repo/x.tsx", 2)).toBe("/@fs/repo/x.tsx?t=2");
    expect(sandboxModuleUrl("repo/x.tsx", 1)).toBe("/@fs/repo/x.tsx?t=1");
  });

  it("pinThreadTitle: generated title → first prompt → anchor label; pinLastActivity", () => {
    const state = pinsFromStatus({ pins: [WIRE_PIN] });
    const pin = state["card-x1"];
    // Fallback: the truncated first user prompt.
    expect(pinThreadTitle(pin)).toBe("hi");
    // Generated title wins.
    expect(pinThreadTitle({ ...pin, title: "Denser card" })).toBe("Denser card");
    // No prompt yet → the anchor label.
    expect(pinThreadTitle({ ...pin, thread: [] })).toBe("Card");
    // Long prompts truncate with an ellipsis.
    const long = pinThreadTitle({
      ...pin,
      thread: [{ role: "user", text: "x".repeat(100), at: 1 }],
    });
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("…")).toBe(true);
    expect(pinLastActivity(pin)).toBe(5); // createdAt 5 > thread at 1
    expect(
      pinLastActivity({
        ...pin,
        thread: [{ role: "assistant", text: "ok", at: 99 }],
      }),
    ).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Sandbox overrides O1: changeset/switch store + the in-place derivations.
// ---------------------------------------------------------------------------

const WIRE_CHANGESET = {
  id: "cs-card-x1",
  threadPinId: "card-x1",
  active: true,
  drifted: false,
  basedOnInactive: false,
  dataAdditionCount: 0,
  overrides: [
    {
      module: "src/Card.tsx",
      exportName: "ProductCard",
      variantFiles: [
        ".designbook/changesets/cs-card-x1/alts/compact/src/Card.tsx",
      ],
      // LAYERS: alt ids are explicit — mirrored paths keep the module
      // basename, so ids are never derived from file names.
      alternatives: ["compact"],
      selection: "compact",
    },
  ],
};

function o1Store(): SandboxStore {
  return storeFromStatus({
    pins: [WIRE_PIN],
    changesets: [WIRE_CHANGESET],
    switches: {
      "src/Card.tsx#ProductCard": {
        changesetId: "cs-card-x1",
        variantId: "compact",
      },
    },
  } as never);
}

describe("O1 store (changesets + switches)", () => {
  it("reconstructs changesets + switches from status; legacy payloads yield empties", () => {
    const store = o1Store();
    expect(store.changesets).toEqual([WIRE_CHANGESET]);
    expect(store.switches["src/Card.tsx#ProductCard"]).toEqual({
      changesetId: "cs-card-x1",
      variantId: "compact",
    });
    const legacy = storeFromStatus({ pins: [WIRE_PIN] } as never);
    expect(legacy.changesets).toEqual([]);
    expect(legacy.switches).toEqual({});
  });

  it("folds switch-changed / changesets-changed snapshots; pins events pass through", () => {
    const store = o1Store();
    const flipped = applySandboxStoreEvent(store, {
      type: "switch-changed",
      switches: {},
    });
    expect(flipped.switches).toEqual({});
    expect(flipped.pins).toBe(store.pins);
    const dissolved = applySandboxStoreEvent(store, {
      type: "changesets-changed",
      changesets: [{ ...WIRE_CHANGESET, active: false }],
    });
    expect(dissolved.changesets[0].active).toBe(false);
    const pinEvent = applySandboxStoreEvent(store, {
      type: "turn-start",
      pinId: "card-x1",
    });
    expect(pinEvent.pins["card-x1"].busy).toBe(true);
    expect(pinEvent.changesets).toBe(store.changesets);
  });

  it("derives the in-place variant + the sandbox-active badge", () => {
    const store = o1Store();
    const pin = store.pins["card-x1"];
    expect(sandboxComponentKey("src/Card.tsx", "ProductCard")).toBe(
      "src/Card.tsx#ProductCard",
    );
    expect(activeChangesetForPin(store.changesets, "card-x1")?.id).toBe(
      "cs-card-x1",
    );
    expect(inPlaceVariantId(store, pin)).toBe("compact");
    expect(sandboxOverridesActive(store.changesets)).toBe(true);
    // Original selected → no in-place variant; inactive changeset → no badge.
    expect(inPlaceVariantId({ ...store, switches: {} }, pin)).toBeUndefined();
    expect(
      sandboxOverridesActive([{ ...WIRE_CHANGESET, active: false }]),
    ).toBe(false);
    // A switch owned by ANOTHER changeset does not light this pin's row.
    expect(
      inPlaceVariantId(
        {
          ...store,
          switches: {
            "src/Card.tsx#ProductCard": {
              changesetId: "cs-other",
              variantId: "compact",
            },
          },
        },
        pin,
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sandbox overrides O2: bake progress, drift badges, resolve-on-bake/discard.
// ---------------------------------------------------------------------------

describe("O2 store (bake + drift + discard)", () => {
  it("folds bake-status per changeset; malformed events are no-ops", () => {
    let store = o1Store();
    for (const status of ["queued", "running", "gated"] as const) {
      store = applySandboxStoreEvent(store, {
        type: "bake-status",
        changesetId: "cs-card-x1",
        pinId: "card-x1",
        status,
      });
      expect(store.bakes["cs-card-x1"].status).toBe(status);
    }
    expect(bakeStateForPin(store.bakes, "card-x1")?.status).toBe("gated");
    const failed = applySandboxStoreEvent(store, {
      type: "bake-status",
      changesetId: "cs-card-x1",
      pinId: "card-x1",
      status: "failed",
      error: "typecheck failed",
    });
    expect(failed.bakes["cs-card-x1"]).toMatchObject({
      status: "failed",
      error: "typecheck failed",
    });
    // Junk statuses / missing ids never fold.
    expect(
      applySandboxStoreEvent(store, {
        type: "bake-status",
        changesetId: "cs-card-x1",
        pinId: "card-x1",
        status: "mystery",
      }),
    ).toBe(store);
    expect(
      applySandboxStoreEvent(store, { type: "bake-status", status: "queued" }),
    ).toBe(store);
  });

  it("baked/discarded resolve the pin (history, D3) like replaced", () => {
    for (const type of ["baked", "discarded"] as const) {
      const store = applySandboxStoreEvent(o1Store(), {
        type,
        pinId: "card-x1",
      });
      expect(store.pins["card-x1"].resolved).toBe(true);
      expect(store.pins["card-x1"].busy).toBe(false);
      expect(activePins(store.pins)).toEqual([]);
    }
  });

  it("drifted folds off the wire and badges; the tray counts active changesets", () => {
    const store = applySandboxStoreEvent(o1Store(), {
      type: "changesets-changed",
      changesets: [
        { ...WIRE_CHANGESET, drifted: true },
        { ...WIRE_CHANGESET, id: "cs-2", threadPinId: "p2" },
        { ...WIRE_CHANGESET, id: "cs-3", threadPinId: "p3", active: false },
      ],
    });
    expect(store.changesets[0].drifted).toBe(true);
    expect(store.changesets[1].drifted).toBe(false);
    expect(activeChangesetCount(store.changesets)).toBe(2);
    // Legacy wire records (no drifted field) revive as not-drifted.
    const legacy = applySandboxStoreEvent(o1Store(), {
      type: "changesets-changed",
      changesets: [
        (({ drifted: _drifted, ...rest }) => rest)(WIRE_CHANGESET),
      ],
    });
    expect(legacy.changesets[0].drifted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sandbox overrides O3: basedOnInactive fold + same-export conflicts.
// ---------------------------------------------------------------------------

describe("O3 store (basedOnInactive + conflicts)", () => {
  it("basedOnInactive folds off the wire (legacy records default false)", () => {
    const store = applySandboxStoreEvent(o1Store(), {
      type: "changesets-changed",
      changesets: [
        { ...WIRE_CHANGESET, basedOnInactive: true },
        (({ basedOnInactive: _b, ...rest }) => rest)(WIRE_CHANGESET),
      ],
    });
    expect(store.changesets[0].basedOnInactive).toBe(true);
    expect(store.changesets[1].basedOnInactive).toBe(false);
  });

  it("sameExportConflicts groups ACTIVE changesets by FILE (layers: different exports of one file DO conflict)", () => {
    const changesets = [
      WIRE_CHANGESET,
      {
        ...WIRE_CHANGESET,
        id: "cs-other",
        threadPinId: "other-pin",
        overrides: [
          {
            module: "src/Card.tsx",
            // File-level: a DIFFERENT export of the same file still
            // conflicts (accepted narrowing, changeset-layers spec).
            exportName: "CardFooter",
            variantFiles: [
              ".designbook/changesets/cs-other/alts/dense/src/Card.tsx",
            ],
            alternatives: ["dense"],
          },
        ],
      },
      // Inactive + empty changesets never conflict.
      { ...WIRE_CHANGESET, id: "cs-off", threadPinId: "p-off", active: false },
      {
        ...WIRE_CHANGESET,
        id: "cs-empty",
        threadPinId: "p-empty",
        overrides: [
          {
            module: "src/Card.tsx",
            exportName: "ProductCard",
            variantFiles: [],
            alternatives: [],
          },
        ],
      },
    ];
    expect(sameExportConflicts(changesets)).toEqual([
      {
        component: "src/Card.tsx#ProductCard",
        file: "src/Card.tsx",
        changesetIds: ["cs-card-x1", "cs-other"],
      },
    ]);
    expect(conflictForPin(changesets, "card-x1")?.file).toBe("src/Card.tsx");
    expect(conflictForPin(changesets, "p-off")).toBeUndefined();
    expect(conflictedPinIds(changesets)).toEqual(
      new Set(["card-x1", "other-pin"]),
    );
    // A single active changeset over the file = no conflict.
    expect(sameExportConflicts([WIRE_CHANGESET])).toEqual([]);
    expect(conflictForPin([WIRE_CHANGESET], "card-x1")).toBeUndefined();
    // Wire records WITHOUT alternatives (defensive) still conflict off
    // variantFiles alone.
    const legacyish = changesets.slice(0, 2).map((changeset) => ({
      ...changeset,
      overrides: changeset.overrides.map(
        ({ alternatives: _a, ...rest }) => rest as never,
      ),
    }));
    expect(sameExportConflicts(legacyish)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// G2 store: the reapply offer/progress fold (spec §Selection).
// ---------------------------------------------------------------------------

describe("G2 store (reapply offer)", () => {
  const OFFER = {
    type: "reapply-available",
    changesetId: "cs-card-x1",
    pinId: "card-x1",
    fromRef: "refs/designbook/changesets/cs-card-x1/v/compact",
    fromAlt: "compact",
    toRef: "refs/designbook/changesets/cs-card-x1/v/warm",
    toAlt: "warm",
    count: 2,
  };

  it("offers on reapply-available, tracks running/conflict/failed, clears on done/dismissed", () => {
    let store = applySandboxStoreEvent(o1Store(), OFFER);
    expect(store.reapply).toMatchObject({
      changesetId: "cs-card-x1",
      fromAlt: "compact",
      toAlt: "warm",
      count: 2,
      status: "offered",
    });
    store = applySandboxStoreEvent(store, {
      type: "reapply-started",
      changesetId: "cs-card-x1",
    });
    expect(store.reapply?.status).toBe("running");
    store = applySandboxStoreEvent(store, {
      type: "reapply-conflict",
      changesetId: "cs-card-x1",
    });
    expect(store.reapply?.status).toBe("conflict");
    store = applySandboxStoreEvent(store, {
      type: "reapply-failed",
      changesetId: "cs-card-x1",
      error: "the merge turn could not resolve the conflict",
    });
    expect(store.reapply).toMatchObject({
      status: "failed",
      error: "the merge turn could not resolve the conflict",
    });
    expect(
      applySandboxStoreEvent(store, {
        type: "reapply-done",
        changesetId: "cs-card-x1",
      }).reapply,
    ).toBeUndefined();
    // Decline = client-side dismiss (nothing happens server-side — spec).
    expect(
      applySandboxStoreEvent(store, { type: "reapply-dismissed" }).reapply,
    ).toBeUndefined();
  });

  it("ignores progress for another changeset and malformed offers; a fresh offer replaces a stale one", () => {
    let store = applySandboxStoreEvent(o1Store(), OFFER);
    const foreign = applySandboxStoreEvent(store, {
      type: "reapply-failed",
      changesetId: "cs-other",
      error: "x",
    });
    expect(foreign.reapply?.status).toBe("offered");
    expect(
      applySandboxStoreEvent(o1Store(), { type: "reapply-available" }).reapply,
    ).toBeUndefined();
    store = applySandboxStoreEvent(store, {
      ...OFFER,
      fromAlt: "warm",
      toAlt: "compact",
      count: 1,
    });
    expect(store.reapply).toMatchObject({
      fromAlt: "warm",
      toAlt: "compact",
      count: 1,
      status: "offered",
    });
  });
});

describe("sandboxEventMatchesBranch (branch-session scoping)", () => {
  it("primary viewer folds only untagged events", () => {
    expect(sandboxEventMatchesBranch({}, undefined)).toBe(true);
    expect(sandboxEventMatchesBranch({ branch: "" }, undefined)).toBe(true);
    expect(
      sandboxEventMatchesBranch({ branch: "design/x" }, undefined),
    ).toBe(false);
  });

  it("branch viewer folds only its own branch's events", () => {
    expect(
      sandboxEventMatchesBranch({ branch: "design/x" }, "design/x"),
    ).toBe(true);
    expect(sandboxEventMatchesBranch({}, "design/x")).toBe(false);
    expect(
      sandboxEventMatchesBranch({ branch: "design/y" }, "design/x"),
    ).toBe(false);
  });

  it("a branch ask's COMPLETION folds for that branch's viewer (busy clears); a primary viewer never flickers", () => {
    let store = o1Store();
    const viewer = "design/x";
    const lifecycle = [
      { type: "turn-start", pinId: "card-x1", mode: "edit", branch: viewer },
      { type: "turn-end", pinId: "card-x1", mode: "edit", branch: viewer },
    ];
    for (const event of lifecycle) {
      if (!sandboxEventMatchesBranch(event, viewer)) continue;
      store = applySandboxStoreEvent(store, event);
    }
    expect(store.pins["card-x1"].busy).toBe(false);
    let primary = o1Store();
    for (const event of lifecycle.slice(0, 1)) {
      if (!sandboxEventMatchesBranch(event, undefined)) continue;
      primary = applySandboxStoreEvent(primary, event);
    }
    expect(primary.pins["card-x1"].busy).toBe(false);
  });
});
