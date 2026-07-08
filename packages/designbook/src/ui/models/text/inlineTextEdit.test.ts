import { describe, expect, it, vi } from "vitest";
import { beginInlineEdit, canInlineEditClaim } from "@designbook-ui/models/text/inlineTextEdit";
import type { TextClaim } from "@designbookapp/designbook/config";

/**
 * Minimal DOM stand-ins for `inlineTextEdit.ts`'s exact surface (setAttribute/
 * removeAttribute, addEventListener/removeEventListener, focus, blur,
 * appendChild/remove, childNodes/firstChild/parentElement/parentNode,
 * `Document.createRange`, `Window.getSelection`). This package's vitest
 * environment is "node" (no jsdom) — the module under test threads `doc`/`win`
 * in explicitly for exactly this reason (real canvas vs. iframe realms), so a
 * hand-built fake exercising the same surface is sufficient without a real DOM.
 */

type Listener = (event: { key: string; preventDefault(): void; stopPropagation(): void }) => void;

class FakeTextNode {
  data: string;
  parentNode: FakeElement | null = null;
  constructor(data: string) {
    this.data = data;
  }
  get parentElement() {
    return this.parentNode;
  }
  remove() {
    this.parentNode = null;
  }
}

class FakeElement {
  listeners = new Map<string, Set<Listener>>();
  attrs = new Map<string, string>();
  children: Array<FakeTextNode | FakeElement> = [];
  isContentEditable = false;

  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, event: { key: string; preventDefault(): void; stopPropagation(): void }) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    if (name === "contenteditable") this.isContentEditable = true;
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
    if (name === "contenteditable") this.isContentEditable = false;
  }
  focus() {}
  get childNodes() {
    return this.children;
  }
  get firstChild() {
    return this.children[0];
  }
  appendChild(node: FakeTextNode) {
    this.children.push(node);
    node.parentNode = this;
  }
  get textContent() {
    return this.children.map((c) => (c instanceof FakeTextNode ? c.data : "")).join("");
  }
}

function fakeEvent(key: string) {
  return { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

function makeClaim(overrides: Partial<TextClaim> = {}): {
  claim: TextClaim;
  el: FakeElement;
  textNode: FakeTextNode;
} {
  const el = new FakeElement();
  const textNode = new FakeTextNode("Hello");
  el.appendChild(textNode);

  const claim = {
    adapter: "test",
    value: "Hello",
    kind: "keyed",
    key: "greeting",
    editPath: "locales/en.json",
    node: textNode as unknown as Text,
    element: el as unknown as HTMLElement,
    save: vi.fn().mockResolvedValue(undefined),
    getTemplate: () => "Hello",
    ...overrides,
  } as TextClaim;

  return { claim, el, textNode };
}

function fakeDocWin() {
  const range = { selectNodeContents: vi.fn() };
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
  const doc = { createRange: () => range } as unknown as Document;
  const win = { getSelection: () => selection } as unknown as Window;
  return { doc, win, range, selection };
}

describe("canInlineEditClaim", () => {
  it("allows a keyed claim whose node is its element's only child", () => {
    const { claim } = makeClaim();
    expect(canInlineEditClaim(claim)).toBe(true);
  });

  it("rejects a literal claim", () => {
    const { claim } = makeClaim({ kind: "literal", key: undefined });
    expect(canInlineEditClaim(claim)).toBe(false);
  });

  it("rejects a claim missing a template getter", () => {
    const { claim } = makeClaim({ getTemplate: undefined });
    expect(canInlineEditClaim(claim)).toBe(false);
  });

  it("rejects a claim missing a key", () => {
    const { claim } = makeClaim({ key: undefined });
    expect(canInlineEditClaim(claim)).toBe(false);
  });

  it("rejects a node that isn't its parent's only child", () => {
    const { claim, el } = makeClaim();
    el.appendChild(new FakeTextNode(" world"));
    expect(canInlineEditClaim(claim)).toBe(false);
  });
});

describe("beginInlineEdit", () => {
  it("returns undefined (no side effects) when the shape disallows it", () => {
    const { claim, el } = makeClaim();
    el.appendChild(new FakeTextNode(" world"));
    const { doc, win } = fakeDocWin();
    const onCommit = vi.fn();
    const onEnd = vi.fn();
    const handle = beginInlineEdit(claim, doc, win, { onCommit, onEnd });
    expect(handle).toBeUndefined();
    expect(el.isContentEditable).toBe(false);
  });

  it("swaps in the raw template and makes the element contenteditable", () => {
    const { claim, el, textNode } = makeClaim({ getTemplate: () => "Hello {{name}}" });
    const { doc, win } = fakeDocWin();
    const handle = beginInlineEdit(claim, doc, win, { onCommit: vi.fn(), onEnd: vi.fn() });
    expect(handle).toBeDefined();
    expect(textNode.data).toBe("Hello {{name}}");
    expect(el.isContentEditable).toBe(true);
  });

  it("commits the edited value on blur when it changed and isn't blank", () => {
    const { claim, el, textNode } = makeClaim();
    const { doc, win } = fakeDocWin();
    const onCommit = vi.fn();
    const onEnd = vi.fn();
    beginInlineEdit(claim, doc, win, { onCommit, onEnd });

    textNode.data = "Howdy";
    el.fire("blur", fakeEvent("blur"));

    expect(onCommit).toHaveBeenCalledWith("Howdy");
    expect(onEnd).toHaveBeenCalledTimes(1);
    // Restored to the original template text after commit.
    expect(textNode.data).toBe("Hello");
    expect(el.isContentEditable).toBe(false);
  });

  it("does not commit on blur when the value is unchanged", () => {
    const { claim, el } = makeClaim();
    const { doc, win } = fakeDocWin();
    const onCommit = vi.fn();
    beginInlineEdit(claim, doc, win, { onCommit, onEnd: vi.fn() });

    el.fire("blur", fakeEvent("blur"));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("does not commit on blur when the value is blank", () => {
    const { claim, el, textNode } = makeClaim();
    const { doc, win } = fakeDocWin();
    const onCommit = vi.fn();
    beginInlineEdit(claim, doc, win, { onCommit, onEnd: vi.fn() });

    textNode.data = "   ";
    el.fire("blur", fakeEvent("blur"));

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Enter blurs the element (commit path) instead of inserting a newline", () => {
    const { claim, el, textNode } = makeClaim();
    const { doc, win } = fakeDocWin();
    const onCommit = vi.fn();
    const blurSpy = vi.spyOn(el, "focus"); // sanity: focus exists
    beginInlineEdit(claim, doc, win, { onCommit, onEnd: vi.fn() });
    textNode.data = "Howdy";
    const event = fakeEvent("Enter");
    // No native blur() in the fake — simulate by firing blur directly, as the
    // real `el.blur()` call inside the module would trigger in a real DOM.
    (el as unknown as { blur: () => void }).blur = () => el.fire("blur", fakeEvent("blur"));
    el.fire("keydown", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith("Howdy");
    blurSpy.mockRestore();
  });

  it("Escape restores the original text and ends the edit without committing", () => {
    const { claim, el, textNode } = makeClaim();
    const { doc, win } = fakeDocWin();
    const onCommit = vi.fn();
    const onEnd = vi.fn();
    beginInlineEdit(claim, doc, win, { onCommit, onEnd });

    textNode.data = "Howdy";
    const event = fakeEvent("Escape");
    el.fire("keydown", event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(textNode.data).toBe("Hello");
    expect(el.isContentEditable).toBe(false);
  });

  it("cancel() restores the original text and is idempotent", () => {
    const { claim, textNode, el } = makeClaim();
    const { doc, win } = fakeDocWin();
    const onEnd = vi.fn();
    const handle = beginInlineEdit(claim, doc, win, { onCommit: vi.fn(), onEnd });

    textNode.data = "Changed mid-edit";
    handle!.cancel();
    handle!.cancel(); // idempotent — no double onEnd

    expect(textNode.data).toBe("Hello");
    expect(el.isContentEditable).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("stopPropagation option calls event.stopPropagation on Enter/Escape when set", () => {
    const { claim, el } = makeClaim();
    const { doc, win } = fakeDocWin();
    (el as unknown as { blur: () => void }).blur = () => el.fire("blur", fakeEvent("blur"));
    beginInlineEdit(claim, doc, win, {
      onCommit: vi.fn(),
      onEnd: vi.fn(),
      stopPropagation: true,
    });
    const escapeEvent = fakeEvent("Escape");
    el.fire("keydown", escapeEvent);
    expect(escapeEvent.stopPropagation).toHaveBeenCalled();
  });

  it("omits stopPropagation by default (canvas parity)", () => {
    const { claim, el } = makeClaim();
    const { doc, win } = fakeDocWin();
    beginInlineEdit(claim, doc, win, { onCommit: vi.fn(), onEnd: vi.fn() });
    const escapeEvent = fakeEvent("Escape");
    el.fire("keydown", escapeEvent);
    expect(escapeEvent.stopPropagation).not.toHaveBeenCalled();
  });
});
