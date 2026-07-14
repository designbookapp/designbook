---
title: Props panel
description: Typed prop controls generated from your TypeScript, editing the selected instance's JSX usage site through the changeset engine.
---

The **Props** tab of the [right panel](/concepts/full-view/) shows the selected component's
props as controls, and editing one writes straight to the JSX at the selected instance's usage
site — the same site the [Code panel](/concepts/code-panel/) highlights.

## From live values to typed controls

Selecting a component renders its props immediately from the **live fiber's runtime
values** — whatever it's actually being called with right now — then upgrades in place to
**typed controls** once designbook extracts the component's prop schema from its TypeScript
(`react-docgen-typescript`, cached per file, invalidated on file change). A union of string
literals becomes a select; `boolean` becomes a switch; `string` an input; `number` a stepper;
`node` / `function` / `object` render as read-only value badges with a safe preview. Unpassed
optional props show greyed with their declared default.

If the schema can't be extracted for a file (no resolvable `tsconfig.json`, TypeScript not
resolvable, and so on), the panel falls back to values-only — you still see what's currently
passed, just without typed controls.

## Editing writes the usage site

Changing a control edits **one JSX attribute** at the selected instance — added when the prop
wasn't passed, replaced in place, removed when you reset it to its default — located precisely
by parsing the file, so unrelated code in it is untouched. A prop the panel can't locate a
safe edit for (spread props, an unresolvable site) shows read-only with a note instead of
guessing.

The edit routes the same way any other direct edit does: with a [conversation](/concepts/agent/)
open, it lands on that conversation's changeset (so it shows up in
[Changes](/concepts/changesets/) and the [history explorer](/concepts/history/)); with no
conversation open, it writes the real file directly, exactly like a manual token or text edit.
Rapid changes (typing, dragging a stepper) debounce into one write per pause.

## Plugin sections

Integration plugins can append their own collapsible sections below the core controls — the
[Figma integration](/figma/) uses this for its status/push/pull section, shown at the bottom of
the panel when a pushable component is selected and the plugin is configured. See [Integration
plugins](/reference/integration-plugins/).
