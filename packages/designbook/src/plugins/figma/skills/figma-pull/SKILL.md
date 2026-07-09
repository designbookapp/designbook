---
name: figma-pull
description: How to update a designbook component from a Figma pull target (annotated HTML). Use whenever a prompt asks to make a component match a TARGET pulled from Figma, mentions the designbook Figma pull, or shows HTML annotated with data-slot/data-i18n/data-token-*/data-component/data-list attributes.
---

# Updating a component from a Figma pull target

A designer edited the Figma render of a designbook component. The pull hands
you that render as **annotated HTML — a declarative TARGET, not code to
paste**. Your job: rewrite the component's source so it renders this output
for the current props/data, in idiomatic code for this repo.

Always **read the component's current source file before editing** (the
prompt names it). The target reflects ONE rendering — one locale, theme,
mode, and set of adapter dimension values (the prompt lists them when known).
Content that differs only because of props/locale/flags is NOT a design edit.

## Annotation legend

- `data-slot="X"`: dynamic content bound to a prop/field named `X`. The text
  shown is a SAMPLE of the current value — do NOT hardcode it; keep it wired
  to the prop.
- `data-i18n="ns.key"`: translated text (dotted). The FIRST dot-segment is
  the namespace; the entire remainder (dots kept) is the i18next key — e.g.
  `app.cart.add.button` is namespace `app`, key `cart.add.button`. Preserve
  the key; the shown text is the current translation — update the locale
  file only if the text actually changed.
- `data-token-<prop>="collection/name"`: this CSS `<prop>` is bound to the
  design token `collection/name`. Use the theme token (Tailwind class or CSS
  var), never a raw value.
- `data-component="registry.Id"`: a nested registered component renders
  here — use that component; do not inline its markup. Inline styles on the
  node itself (e.g. absolute positioning) still apply to its placement.
- `data-list`: render one child per item of the corresponding array (anchor
  on the existing `.map` in the source). The single child shown is the item
  template.
- `data-slot-if="X"`: conditionally shown slot (`X` is a boolean prop); the
  `hidden` attribute means it is currently off — presence/absence here is
  prop-driven, not a design edit.
- `data-slot-swap="X"`: a swappable instance slot named `X`.
- Unannotated elements and inline `style` are static design — match them.

## Rules

- Produce idiomatic code for this repo (its framework, styling system, and
  conventions) — never paste the HTML/inline styles literally when a
  utility class or existing pattern expresses the same thing.
- Keep the diff MINIMAL: change only what the target actually changed.
  Do not reformat, reorder, or "improve" untouched code.
- Preserve existing prop wiring, i18n keys, token bindings, event handlers,
  accessibility attributes, and component structure wherever the target
  doesn't contradict them.
- Locale files: when a `data-i18n` text changed, update that key in the
  locale file for the RENDERED locale only.
- If a change is ambiguous, destructive, or needs restructuring, ask first
  instead of guessing.
