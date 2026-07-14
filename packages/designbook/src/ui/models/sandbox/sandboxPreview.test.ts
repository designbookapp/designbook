/**
 * Sandbox preview composition tests (docs/specs/sandbox.md v2, E2/E3):
 * the PURE layer composition — component pins keep the two-layer mount
 * (Providers > Variant(capturedProps)); element pins mount three layers
 * (Providers > Controller(V=Variant), the controller supplying the props) —
 * plus the identity-stability of the lazy preview cache.
 */

import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType, type ReactNode } from "react";

// The registry evaluates the config store at import time — stub the one
// helper the preview uses (lenient export resolution is tested elsewhere).
vi.mock("@designbook-ui/models/catalog/componentRegistry", () => ({
  resolveComponentExport: (mod: Record<string, unknown>, key: string) =>
    mod[key] ?? mod.default,
}));

import { composeSandboxNode, makeSandboxPreview } from "./sandboxPreview";
import type { SandboxPinState, SandboxVariantState } from "./sandboxModel";

function Variant() {
  return null;
}
function Providers({ children }: { children?: ReactNode }) {
  return createElement("div", null, children);
}
function Controller({ V }: { V: ComponentType }) {
  return createElement(V);
}

describe("composeSandboxNode", () => {
  it("component pins: two layers — Providers > Variant(capturedProps)", () => {
    const node = composeSandboxNode({
      Variant,
      props: { title: "Vase" },
      Providers,
    });
    expect(node.type).toBe(Providers);
    const inner = (node.props as { children: React.ReactElement }).children;
    expect(inner.type).toBe(Variant);
    expect((inner.props as { title: string }).title).toBe("Vase");
  });

  it("element pins: THREE layers — Providers > Controller(V=Variant)", () => {
    const node = composeSandboxNode({
      Variant,
      props: {},
      Providers,
      Controller,
    });
    expect(node.type).toBe(Providers);
    const inner = (node.props as { children: React.ReactElement }).children;
    expect(inner.type).toBe(Controller);
    // The controller receives the variant COMPONENT — it renders <V {...props}/>.
    expect((inner.props as { V: ComponentType }).V).toBe(Variant);
  });

  it("degrades inward when layers are missing (bare variant still previews)", () => {
    const bare = composeSandboxNode({ Variant, props: { a: 1 } });
    expect(bare.type).toBe(Variant);
    const noProviders = composeSandboxNode({ Variant, props: {}, Controller });
    expect(noProviders.type).toBe(Controller);
  });
});

describe("makeSandboxPreview cache identity", () => {
  const basePin: SandboxPinState = {
    id: "card-x1",
    createdAt: 1,
    kind: "component",
    target: { file: "src/Card.tsx", exportName: "ProductCard", name: "Card" },
    resolved: false,
    busy: false,
    planning: false,
    directorActivity: [],
    thread: [],
    variants: [],
    wrapperAbsPath: "/repo/.designbook/sandbox/card-x1/wrapper.tsx",
  };
  const variant: SandboxVariantState = {
    id: "compact",
    intent: "denser",
    file: ".designbook/sandbox/card-x1/compact.tsx",
    absPath: "/repo/.designbook/sandbox/card-x1/compact.tsx",
    x: 0,
    y: 0,
    status: "ready",
    rev: 1,
    activity: [],
  };

  it("is identity-stable per (pin, variant, rev) and retires on rev bumps", () => {
    const first = makeSandboxPreview(basePin, variant);
    expect(first).toBeDefined();
    expect(makeSandboxPreview(basePin, variant)).toBe(first);
    expect(makeSandboxPreview(basePin, { ...variant, rev: 2 })).not.toBe(first);
    // Not landed yet → nothing to mount.
    expect(
      makeSandboxPreview(basePin, { ...variant, status: "generating" }),
    ).toBeUndefined();
    expect(
      makeSandboxPreview(basePin, { ...variant, absPath: undefined }),
    ).toBeUndefined();
  });

  it("element pins key the cache on the controller too (three-layer mount)", () => {
    const elementPin: SandboxPinState = {
      ...basePin,
      id: "card-e1",
      kind: "element",
      controllerAbsPath: "/repo/.designbook/sandbox/card-e1/controller.tsx",
    };
    const withController = makeSandboxPreview(elementPin, variant);
    const withoutController = makeSandboxPreview(
      { ...elementPin, controllerAbsPath: undefined },
      variant,
    );
    expect(withController).toBeDefined();
    expect(withoutController).toBeDefined();
    expect(withController).not.toBe(withoutController);
  });
});
