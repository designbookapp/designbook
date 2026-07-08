import { describe, expect, it } from "vitest";
import {
  decodeMarker,
  encodeMarker,
  getMarkerEntry,
} from "@designbook-ui/models/text/i18nMarkers";
import { createPageMark } from "./pageMark";

/** A mark fn that is active and defaults to namespace "app" (the fixture shape). */
function activeMark() {
  return createPageMark({ isActive: () => true, defaultNs: () => "app" });
}

/** Decode a marked string back to its registered marker entry. */
function entryOf(marked: string) {
  const index = decodeMarker(marked);
  expect(index).toBeTypeOf("number");
  return getMarkerEntry(index as number);
}

describe("createPageMark — gating", () => {
  it("passes the value through untouched when inactive", () => {
    const mark = createPageMark({ isActive: () => false, defaultNs: () => "app" });
    expect(mark("Welcome back", "greeting.title")).toBe("Welcome back");
    expect(decodeMarker(mark("x", "k") as string)).toBeUndefined();
  });

  it("passes non-string / empty values through", () => {
    const mark = activeMark();
    expect(mark(42, "k")).toBe(42);
    expect(mark(undefined, "k")).toBeUndefined();
    expect(mark("", "k")).toBe("");
  });

  it("passes through when the key is missing or a @meta key", () => {
    const mark = activeMark();
    expect(mark("v", undefined)).toBe("v");
    expect(mark("v", "@greeting")).toBe("v");
  });

  it("does not double-mark a value already marked by the postProcessor", () => {
    // Apps rendering through the shared instance get the postProcessor's marker
    // first; `__dbMark` must be a no-op on an already-marked value.
    const already = "Welcome back" + encodeMarker(0);
    expect(activeMark()(already, "greeting.title")).toBe(already);
  });
});

describe("createPageMark — page-side marker table registration", () => {
  it("appends a marker resolving to {namespace, key} via the shared decoder", () => {
    const mark = activeMark();
    const marked = mark("Welcome back", "greeting.title") as string;
    expect(marked.startsWith("Welcome back")).toBe(true);
    expect(marked).not.toBe("Welcome back");

    const entry = entryOf(marked);
    expect(entry).toMatchObject({
      namespace: "app",
      key: "greeting.title",
      resolvedKey: "greeting.title",
    });
  });

  it("splits an explicit `ns:key` prefix into namespace + key", () => {
    const marked = activeMark()("Hi", "common:greeting.title") as string;
    expect(entryOf(marked)).toMatchObject({
      namespace: "common",
      key: "greeting.title",
    });
  });

  it("prefers an explicit ns argument over the default", () => {
    const marked = activeMark()("Hi", "greeting.title", "web") as string;
    expect(entryOf(marked)).toMatchObject({ namespace: "web", key: "greeting.title" });
  });

  it("falls back to the configured default namespace", () => {
    const mark = createPageMark({ isActive: () => true, defaultNs: () => "translation" });
    const marked = mark("Hi", "farewell.note") as string;
    expect(entryOf(marked)).toMatchObject({
      namespace: "translation",
      key: "farewell.note",
    });
  });

  it("marks a plural key with the BARE key — no `options.count` reaches __dbMark", () => {
    // The build transform wraps `t(key, opts)` as `__dbMark(t(key, opts), key)`:
    // only the verbatim source key crosses the boundary, never `opts`, so a
    // plural call site (e.g. `t("results.count", { count })`) always marks the
    // UNSUFFIXED base key — unlike the canvas's postProcessor, which runs
    // inside i18next and can compute the active `_one`/`_other` suffix from
    // `options.count`. `resolvePluralForms` (pluralForms.ts) normalizes both
    // shapes to the same family, so this is safe by design — see its tests.
    const marked = activeMark()("5 trips", "results.count") as string;
    expect(entryOf(marked)).toMatchObject({
      namespace: "app",
      key: "results.count",
      resolvedKey: "results.count",
    });
  });
});
