import { describe, expect, it, vi } from "vitest";
import type { HostContextSource } from "@designbookapp/designbook/config";
import type { NamespacedDimension } from "./adapterAggregate";
import {
  FOLLOW_APP,
  contextEquals,
  initialPickState,
  matchHostSources,
  resolveEffective,
} from "./hostContext";

const localeDim: NamespacedDimension = {
  id: "i18next:locale",
  label: "Language",
  options: [
    { value: "en-US", label: "EN" },
    { value: "fr-FR", label: "FR" },
  ],
  defaultValue: "en-US",
  adapterName: "i18next",
};

const tenantDim: NamespacedDimension = {
  id: "flags:tenant",
  label: "Tenant",
  options: [{ value: "acme", label: "Acme" }],
  defaultValue: "acme",
  adapterName: "flags",
};

function source(value: string | undefined, withSubscribe = false): HostContextSource {
  return {
    get: () => value,
    subscribe: withSubscribe ? () => () => {} : undefined,
  };
}

describe("matchHostSources", () => {
  it("matches by adapter-local id and namespaced id, injected only", () => {
    const byLocal = matchHostSources(
      [localeDim, tenantDim],
      { locale: source("de-DE") },
      true,
    );
    expect([...byLocal.keys()]).toEqual(["i18next:locale"]);

    const byNamespaced = matchHostSources(
      [localeDim],
      { "i18next:locale": source("de-DE") },
      true,
    );
    expect([...byNamespaced.keys()]).toEqual(["i18next:locale"]);
  });

  it("host mode (not injected) ignores hostContext entirely", () => {
    const map = matchHostSources([localeDim], { locale: source("de-DE") }, false);
    expect(map.size).toBe(0);
  });

  it("returns empty when no hostContext declared", () => {
    expect(matchHostSources([localeDim], undefined, true).size).toBe(0);
  });
});

describe("initialPickState", () => {
  it("host-context dims start following; plain dims start at default", () => {
    const sources = matchHostSources([localeDim, tenantDim], { locale: source("de-DE") }, true);
    expect(initialPickState([localeDim, tenantDim], {}, sources)).toEqual({
      "i18next:locale": FOLLOW_APP,
      "flags:tenant": "acme",
    });
  });

  it("persisted value overrides the follow/default start", () => {
    const sources = matchHostSources([localeDim], { locale: source("de-DE") }, true);
    expect(
      initialPickState([localeDim], { "i18next:locale": "fr-FR" }, sources),
    ).toEqual({ "i18next:locale": "fr-FR" });
  });
});

describe("resolveEffective — resolution order", () => {
  it("explicit pick wins over the host value", () => {
    const sources = matchHostSources([localeDim], { locale: source("de-DE") }, true);
    const { context, follow } = resolveEffective(
      [localeDim],
      { "i18next:locale": "fr-FR" },
      sources,
    );
    expect(context["i18next:locale"]).toBe("fr-FR");
    expect(follow["i18next:locale"]).toEqual({ following: false, appValue: "de-DE" });
  });

  it("follows the host value when following", () => {
    const sources = matchHostSources([localeDim], { locale: source("de-DE") }, true);
    const { context, follow } = resolveEffective(
      [localeDim],
      { "i18next:locale": FOLLOW_APP },
      sources,
    );
    expect(context["i18next:locale"]).toBe("de-DE");
    expect(follow["i18next:locale"]).toEqual({ following: true, appValue: "de-DE" });
  });

  it("falls back to the dimension default when the host value is undefined", () => {
    const sources = matchHostSources([localeDim], { locale: source(undefined) }, true);
    const { context } = resolveEffective(
      [localeDim],
      { "i18next:locale": FOLLOW_APP },
      sources,
    );
    expect(context["i18next:locale"]).toBe("en-US");
  });

  it("re-reads get() live (subscribe wiring drives this on change)", () => {
    let lang = "en-US";
    const sources = matchHostSources(
      [localeDim],
      { locale: { get: () => lang } },
      true,
    );
    const pick = { "i18next:locale": FOLLOW_APP };
    expect(resolveEffective([localeDim], pick, sources).context["i18next:locale"]).toBe("en-US");
    lang = "fr-FR";
    expect(resolveEffective([localeDim], pick, sources).context["i18next:locale"]).toBe("fr-FR");
  });

  it("host mode: hostContext ignored, plain pick/default only", () => {
    const sources = matchHostSources([localeDim], { locale: source("de-DE") }, false);
    const { context, follow } = resolveEffective([localeDim], {}, sources);
    expect(context["i18next:locale"]).toBe("en-US");
    expect(follow["i18next:locale"]).toBeUndefined();
  });

  it("swallows a throwing getter, falling back to default", () => {
    const sources = matchHostSources(
      [localeDim],
      {
        locale: {
          get: () => {
            throw new Error("boom");
          },
        },
      },
      true,
    );
    const { context } = resolveEffective(
      [localeDim],
      { "i18next:locale": FOLLOW_APP },
      sources,
    );
    expect(context["i18next:locale"]).toBe("en-US");
  });
});

describe("subscribe wiring", () => {
  it("identifies sources that offer a subscribe (live) vs poll fallback", () => {
    const live = matchHostSources([localeDim], { locale: source("en-US", true) }, true);
    const sub = live.get("i18next:locale")!.subscribe;
    expect(typeof sub).toBe("function");
    const cb = vi.fn();
    const unsub = sub!(cb);
    expect(typeof unsub).toBe("function");
  });
});

describe("contextEquals", () => {
  it("shallow-compares context maps", () => {
    expect(contextEquals({ a: "1" }, { a: "1" })).toBe(true);
    expect(contextEquals({ a: "1" }, { a: "2" })).toBe(false);
    expect(contextEquals({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  });
});
