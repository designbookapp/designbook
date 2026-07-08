/**
 * Pure mapping for authoring NATIVE Figma Component Properties on push.
 * A slot descriptor maps to a
 * `componentPropertyDefinitions` entry (TEXT / BOOLEAN / INSTANCE_SWAP) plus the
 * `componentPropertyReferences` aspect it drives; `collectMainSlots` gathers the
 * slots a component main can originate. render.ts does the live-Figma wiring
 * (`figma.addComponentProperty` / `componentPropertyReferences`) — this module
 * is the pure, testable core.
 *
 * Framework-free and ES2017-safe: compiled by the node/ui tsconfigs AND by the
 * Figma plugin's tsconfig.
 */

import type { RenderNode } from "./figmaRender.ts";
import { DEFAULT_NAMESPACE, i18nBinding } from "./figmaSlots.ts";

type SlotKind = "text" | "boolean" | "instanceSwap";

/** A slot to originate as a native Figma Component Property. */
type SlotDescriptor =
  | { kind: "text"; name: string; defaultValue: string }
  | { kind: "boolean"; name: string; defaultValue: boolean }
  /** `defaultValue` is the default main component id (INSTANCE_SWAP). */
  | { kind: "instanceSwap"; name: string; defaultValue: string };

type ComponentPropertyType = "TEXT" | "BOOLEAN" | "INSTANCE_SWAP";

/** The `componentPropertyDefinitions` entry a descriptor maps to. */
type ComponentPropertyDef = {
  name: string;
  type: ComponentPropertyType;
  defaultValue: string | boolean;
};

/** Maps a slot descriptor to its native component-property definition. */
function slotDescriptorToPropertyDef(slot: SlotDescriptor): ComponentPropertyDef {
  switch (slot.kind) {
    case "text":
      return { name: slot.name, type: "TEXT", defaultValue: slot.defaultValue };
    case "boolean":
      return { name: slot.name, type: "BOOLEAN", defaultValue: slot.defaultValue };
    default:
      return {
        name: slot.name,
        type: "INSTANCE_SWAP",
        defaultValue: slot.defaultValue,
      };
  }
}

/** The `componentPropertyReferences` aspect a property of this kind drives. */
function slotReferenceAspect(
  kind: SlotKind,
): "characters" | "visible" | "mainComponent" {
  if (kind === "text") return "characters";
  if (kind === "boolean") return "visible";
  return "mainComponent";
}

/**
 * Collects the content slots to originate as native properties from a
 * component-main subtree. Today the only push-side slot signal is i18n text
 * (→ TEXT properties named `i18n.<ns>.<key>`); the walk stops at nested
 * registered components (their slots belong to their own main). Deduped by
 * name (a component-property name must be unique).
 */
function collectMainSlots(
  root: RenderNode,
  defaultNamespace: string = DEFAULT_NAMESPACE,
): SlotDescriptor[] {
  const out: SlotDescriptor[] = [];
  const seen = new Set<string>();
  const walk = (node: RenderNode): void => {
    if (node.type === "childComponent") return; // its own main owns its slots
    if (node.type === "text" && node.text && node.text.i18n) {
      const name = i18nBinding(
        node.text.i18n.namespace,
        node.text.i18n.key,
        defaultNamespace,
      ).propertyName;
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ kind: "text", name, defaultValue: node.text.characters });
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}

export { collectMainSlots, slotDescriptorToPropertyDef, slotReferenceAspect };
export type {
  ComponentPropertyDef,
  ComponentPropertyType,
  SlotDescriptor,
  SlotKind,
};
