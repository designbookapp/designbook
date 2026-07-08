import { describe, expect, it } from "vitest";
import {
  aggregateDimensions,
  aggregateTabs,
  initialContext,
  namespaceId,
  type AdapterContribution,
} from "./adapterAggregate";

const noopFields = () => [];

const contributions: AdapterContribution[] = [
  {
    name: "i18next",
    dimensions: [
      {
        id: "locale",
        label: "Language",
        options: [
          { value: "en-US", label: "EN" },
          { value: "fr-FR", label: "FR" },
        ],
        defaultValue: "en-US",
      },
    ],
  },
  {
    name: "flags",
    dimensions: [
      {
        id: "tenant",
        label: "Tenant",
        options: [
          { value: "acme", label: "Acme" },
          { value: "globex", label: "Globex" },
        ],
        defaultValue: "acme",
      },
    ],
    tabs: [{ id: "flags", label: "Flags", icon: "flag", fields: noopFields }],
  },
];

describe("namespaceId", () => {
  it("prefixes ids with the adapter name", () => {
    expect(namespaceId("flags", "tenant")).toBe("flags:tenant");
  });
});

describe("aggregateDimensions", () => {
  it("namespaces every dimension id and tags its adapter", () => {
    const dimensions = aggregateDimensions(contributions);
    expect(dimensions.map((d) => d.id)).toEqual([
      "i18next:locale",
      "flags:tenant",
    ]);
    expect(dimensions[1].adapterName).toBe("flags");
    // Options are preserved untouched.
    expect(dimensions[0].options).toHaveLength(2);
  });

  it("keeps same-named ids from different adapters distinct", () => {
    const dimensions = aggregateDimensions([
      { name: "a", dimensions: [{ id: "x", label: "X", options: [], defaultValue: "1" }] },
      { name: "b", dimensions: [{ id: "x", label: "X", options: [], defaultValue: "2" }] },
    ]);
    expect(dimensions.map((d) => d.id)).toEqual(["a:x", "b:x"]);
  });
});

describe("aggregateTabs", () => {
  it("namespaces tab ids and tags the owning adapter", () => {
    const tabs = aggregateTabs(contributions);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].id).toBe("flags:flags");
    expect(tabs[0].adapterName).toBe("flags");
  });
});

describe("initialContext", () => {
  it("builds defaults from each dimension", () => {
    const dimensions = aggregateDimensions(contributions);
    expect(initialContext(dimensions)).toEqual({
      "i18next:locale": "en-US",
      "flags:tenant": "acme",
    });
  });

  it("overlays persisted values by namespaced id", () => {
    const dimensions = aggregateDimensions(contributions);
    expect(
      initialContext(dimensions, { "flags:tenant": "globex" }),
    ).toEqual({
      "i18next:locale": "en-US",
      "flags:tenant": "globex",
    });
  });
});
