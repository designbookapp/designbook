---
name: variations
description: How to write ONE design variation of a designbook component into .designbook/variations/. Use whenever a prompt says to create a design variation using the variations skill, or names a target file inside .designbook/variations/.
---

# Writing a design variation

designbook's variation explorer fans your prompt out: you are ONE of several
parallel sessions, each writing ONE candidate implementation of the same
component in a different design direction. Your candidate renders live on the
designbook canvas next to the original the moment your file lands.

## Rules

- **Read the original component's source first** (the prompt names it). Also
  read anything it imports that you need to understand (atoms, context,
  tokens).
- **Write EXACTLY the one target file the prompt names** (inside
  `.designbook/variations/`). Never create, edit, or delete any other file —
  no locale edits, no token edits, no new dependencies, nothing.
- **First line**: a provenance header comment:
  `/** designbook:variation of <original path> — "<slug>": <one-line intent> */`
- **Same contract as the original**: exactly one exported React component,
  with the SAME export name and an IDENTICAL props type. It renders in the
  original's place under the same wrappers/providers — same context reads,
  same i18n keys, same data expectations.
- **Imports must resolve from the variation file's location.** The file lives
  in the app's `.designbook/variations/` dir (in a monorepo that is
  `<app dir>/.designbook/variations/`, NOT the git root — the prompt names the
  exact target path and the import prefix), so relative imports into app
  source need the right number of `../` segments; repo path aliases work as
  usual.
- **Reuse, don't invent**: the app's existing components/atoms, i18n keys,
  design tokens/utility classes. Introduce no new dependencies and no new
  i18n keys.
- **The root must have intrinsic height.** Never derive the component's size
  solely from absolutely-positioned children (an absolute hero over an empty
  root collapses to zero and renders as nothing). Overlays sit on top of a
  normally-flowing base — e.g. the image element sets the height, the overlay
  is positioned over it.
- **Vary the DESIGN, not the palette-noise**: interpret the assigned direction
  through layout, hierarchy, density, and emphasis. The result should be
  recognizably the same component with a genuinely different design point of
  view — not a recolor.
- Keep the file self-contained and idiomatic for this repo (its styling
  system and conventions).
