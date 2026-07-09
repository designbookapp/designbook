import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenSource } from "../../integration/index.ts";
import {
  getTokenSources,
  registerTokenSource,
  resetTokenSources,
  subscribeTokenSources,
  unregisterTokenSource,
} from "./tokenSources";

function source(id: string): TokenSource {
  return { id, modes: ["light"], getTokens: () => [] };
}

afterEach(() => resetTokenSources());

describe("tokenSources registry", () => {
  it("registers, lists, and replaces by id", () => {
    const a = source("theme");
    registerTokenSource(a);
    expect(getTokenSources()).toEqual([a]);

    const a2 = source("theme");
    registerTokenSource(a2);
    expect(getTokenSources()).toEqual([a2]);

    const b = source("brand");
    registerTokenSource(b);
    expect(getTokenSources()).toEqual([a2, b]);
  });

  it("notifies subscribers with a fresh snapshot identity", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTokenSources(listener);
    const before = getTokenSources();
    registerTokenSource(source("theme"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getTokenSources()).not.toBe(before);

    unsubscribe();
    unregisterTokenSource("theme");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getTokenSources()).toEqual([]);
  });
});
