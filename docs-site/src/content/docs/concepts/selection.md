---
title: Selection & drill-in
description: Selecting components on the canvas, drilling into nested elements, and where selection feeds the code panel and agent.
---

Selecting something on the canvas is how you tell the rest of the workbench what you want to
work on — it drives the [code panel](/concepts/code-panel/), the adapter tabs, and the
context you hand to the [Pi agent](/concepts/agent/).

## Activate the select tool

Selection is a **tool**, and it is not the default. Activate the **select tool from the
bottom toolbar** before clicking a component — otherwise a click pans or interacts with the
canvas rather than selecting. This trips people up the first time, so it's worth calling out:
if clicking a component does nothing, check that the select tool is active in the bottom
toolbar.

## Drill-in

With the select tool active, clicking selects a component entry. Clicking again drills into
the element under the cursor — down through the rendered DOM of that component — so you can
target a specific heading, button, or text node rather than the whole component. This is what
lets the text tool attribute an individual rendered string back to its source (see [Text
& i18next](/adapters/text/)), and what gives the agent a precise anchor for edits.

## What selection feeds

- **The code panel** shows the source file attributed to the current selection.
- **Adapter tabs** (Theme, Flags, …) act on the active context, which selection and the
  toolbar dimensions together determine.
- **The agent** can reference the selected component and element when you describe a change.
