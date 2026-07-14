---
title: Selection & drill-in
description: Selecting anything in your running app, drilling into nested elements, and where selection feeds the Props panel, Code panel, and chat.
---

Selecting something in your running app is how you tell the rest of the [full
view](/concepts/full-view/) what you want to work on — it drives the [Props
panel](/concepts/props-panel/), the [Code panel](/concepts/code-panel/), and the context you
hand [chat](/concepts/agent/).

## Activate the select tool

Selection is a **tool**, and it isn't the default. Activate **Select** from the **footer tool
picker** before clicking — otherwise a click just interacts with your app normally (clicks a
button, follows a link) rather than selecting it. This trips people up the first time: if
clicking something does nothing but what it normally does, check that Select is active in the
footer.

Selection works on **anything rendered in your app**, not just components you registered in
your config. A registered component shows its registered name; anything else shows its tag and
class/id (for example `div.card`). Either way, the Code panel can usually still find its
source — see [Component registration](/concepts/component-sets/) for what registration
actually buys you.

## Drill-in

With Select active, clicking selects the outermost thing under the cursor. Clicking again
drills into the element under the cursor — down through the rendered DOM — so you can target a
specific heading, button, or text node rather than the whole component. This is what lets the
[text tool](/adapters/text/) attribute an individual rendered string back to its source, and
what gives chat a precise anchor for an edit ("make **this** bigger" instead of "make the
button bigger").

## What selection feeds

- **The Props panel** shows the selected instance's live values, upgrading to typed controls
  once its schema resolves.
- **The Code panel** shows the source file attributed to the selection, highlighting the usage
  line for a drilled-in element.
- **Chat** carries the selection along as a pin chip on your next message, so the agent knows
  exactly what "this" refers to.
