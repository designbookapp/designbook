/**
 * Sandbox variant rendering: compose the pin's generated wrapper module
 * (captured props + snapshot-stub providers, D2) with a variant module via
 * `/@fs/` dynamic imports — the variations landing mechanism, plus the
 * wrapper layer. The UI does the composition, so variant files stay plain
 * components (same export name/props contract as the original) and the
 * wrapper stays declarative data + providers.
 *
 * Mount shapes (docs/specs/sandbox.md v2, E2/E3):
 *   - COMPONENT pins (unchanged): SandboxProviders > Variant(capturedProps)
 *   - ELEMENT pins (three layers): SandboxProviders > Controller(V=Variant)
 *     — the LLM-authored controller derives the props via the app's real
 *     hooks and renders `<V {...props} />`; variants export `Original`.
 *
 * IDENTITY-STABLE like `synthesizeVariantEntry`: the lazy component is cached
 * per (pin, variant, rev) — a fresh React.lazy per render re-suspends every
 * parent re-render (the variations live-verify lesson). The rev in the key
 * retires stale entries after an iterate.
 */

import {
  createElement,
  lazy,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { resolveComponentExport } from "@designbook-ui/models/catalog/componentRegistry";
import { sandboxModuleUrl } from "./sandboxModel";
import type { SandboxPinState, SandboxVariantState } from "./sandboxModel";

type WrapperModule = {
  capturedProps?: Record<string, unknown>;
  SandboxProviders?: ComponentType<{ children?: ReactNode }>;
};

type ControllerModule = {
  Controller?: ComponentType<{ V: ComponentType }>;
};

/** Element-pin export convention (mirrors the server's ELEMENT_EXPORT_NAME). */
const ELEMENT_EXPORT_NAME = "Original";

/**
 * PURE composition of the mount layers (unit-testable without a DOM):
 * Providers > Controller(V=Variant) for element pins with a working
 * controller; Providers > Variant(props) otherwise. Missing layers degrade
 * inward — the variant itself may still be fine.
 */
function composeSandboxNode(params: {
  Variant: ComponentType;
  props: Record<string, unknown>;
  Providers?: ComponentType<{ children?: ReactNode }>;
  Controller?: ComponentType<{ V: ComponentType }>;
}): ReactElement {
  const { Variant, props, Providers, Controller } = params;
  const inner = Controller
    ? createElement(Controller, { V: Variant })
    : createElement(Variant, props);
  return Providers ? createElement(Providers, null, inner) : inner;
}

const previewCache = new Map<string, ComponentType>();

/**
 * The lazy composed preview for a READY variant, or undefined before landing.
 * A missing/broken wrapper degrades to rendering the variant bare (captured
 * props lost) rather than a red cell — the variant itself may still be fine.
 */
function makeSandboxPreview(
  pin: SandboxPinState,
  variant: SandboxVariantState,
): ComponentType | undefined {
  if (variant.status !== "ready" && variant.status !== "updating") {
    return undefined;
  }
  if (!variant.absPath) return undefined;
  // O3: a FULL-MODULE variant (edit-variant — moduleFile === file) exports
  // the OWNER component itself; mount it component-style (no controller,
  // owner export name) even on element pins.
  const fullModule =
    variant.moduleFile !== undefined && variant.moduleFile === variant.file;
  const controllerAbsPath =
    pin.kind === "element" && !fullModule ? pin.controllerAbsPath : undefined;
  const cacheKey = `${pin.id}|${variant.id}#${variant.rev}|${variant.absPath}|${pin.wrapperAbsPath ?? ""}|${controllerAbsPath ?? ""}`;
  const cached = previewCache.get(cacheKey);
  if (cached) return cached;

  const variantUrl = sandboxModuleUrl(variant.absPath, variant.rev);
  // The wrapper/controller only change when regenerated; the variant rev is a
  // fine cache-bust for them too (same pin dir, same landing run — and a
  // render auto-fix that edits the controller bumps the rev).
  const wrapperUrl = pin.wrapperAbsPath
    ? sandboxModuleUrl(pin.wrapperAbsPath, variant.rev)
    : undefined;
  const controllerUrl = controllerAbsPath
    ? sandboxModuleUrl(controllerAbsPath, variant.rev)
    : undefined;
  const exportName =
    pin.kind === "element" && !fullModule
      ? ELEMENT_EXPORT_NAME
      : pin.target.exportName;

  const Composed = lazy(async () => {
    const variantModule = await import(/* @vite-ignore */ variantUrl);
    const wrapperModule: WrapperModule = wrapperUrl
      ? await import(/* @vite-ignore */ wrapperUrl).catch(() => ({}))
      : {};
    const controllerModule: ControllerModule = controllerUrl
      ? await import(/* @vite-ignore */ controllerUrl).catch(() => ({}))
      : {};
    // Lenient export resolution: the named export when present, else the
    // default/sole export (skill rules ask for the exact name, but a slightly
    // off variant should still preview rather than red-cell).
    const Variant = resolveComponentExport(variantModule, exportName);
    const props =
      wrapperModule.capturedProps &&
      typeof wrapperModule.capturedProps === "object"
        ? wrapperModule.capturedProps
        : {};
    const Providers =
      typeof wrapperModule.SandboxProviders === "function"
        ? wrapperModule.SandboxProviders
        : undefined;
    const Controller =
      typeof controllerModule.Controller === "function"
        ? controllerModule.Controller
        : undefined;
    function SandboxComposedPreview() {
      return composeSandboxNode({
        Variant,
        // Element pins: the CONTROLLER supplies the props (real hooks +
        // inlined locals) — capturedProps stay a component-pin concept.
        // Full-module variants mount the owner export with capturedProps.
        props: pin.kind === "element" && !fullModule ? {} : props,
        Providers,
        Controller,
      });
    }
    return { default: SandboxComposedPreview };
  });

  previewCache.set(cacheKey, Composed);
  return Composed;
}

export { composeSandboxNode, makeSandboxPreview };
