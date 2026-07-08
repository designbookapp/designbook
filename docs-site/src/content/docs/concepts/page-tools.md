---
title: Live-app editing
description: Select, prompt, and edit text directly on your running app — the tool strip, the App page, and how they relate to the full canvas.
---

The canvas isn't the only place to select a component, prompt Pi, or edit text — you can do
all three **directly on your running app**, without opening the full workbench first. Click the
`◈ designbook` pill and instead of the full-screen overlay, a compact **tool strip** appears
over your app. The app stays fully interactive underneath; the strip is chrome, not a mode
switch.

This page covers the tool strip and the **App page** it escalates into. Both are
[injected mode](/getting-started/injected-mode/) features — host mode has no running app to
point them at.

## The tool strip

Clicking the pill opens a small bar in the corner with five tools: **Select**, **Edit text**,
**Chat with Pi**, **Open canvas**, and **Close**. Nothing else on the page changes — your app's
URL, scroll position, and state are untouched, and it stays interactive except while a tool is
actively capturing clicks.

### Select

Activate **Select**, then hover and click anywhere on the live page. A chip appears showing
what you hit: the component's registered name if it's one of your registered entries, or its
tag and class/id (e.g. `div.card`) if it isn't. From the chip:

- **Prompt Pi** — opens the chat drawer with that selection as context, so "make this bigger"
  or "fix the spacing here" resolves against a precise anchor instead of a vague description.
- **Go to component** — jumps straight to that entry in the full canvas (only available for a
  registered component; not every DOM node is one).

### Edit text

Activate **Edit text**, then click any rendered string. Text wired through an i18n
[text adapter](/adapters/text/) edits **inline, in place** — type the change and it commits on
Enter or blur (Escape cancels), writing back to the same locale file or literal source the
canvas text tool would use, with no page reload. A few shapes (plurals, strings split across
multiple DOM nodes, placeholder-heavy strings) open the same structured editor the canvas uses
instead of inline editing, since a plain contenteditable can't represent them safely.

A string the active text adapter chain doesn't recognize as translatable shows a small
**"Not an i18n string"** callout rather than guessing — from there you can dismiss it or ask
Pi to make the change instead.

### Chat with Pi

Opens a compact chat drawer bound to the same agent session the full workbench uses — handy for
a quick prompt without leaving the page you're looking at.

### Open canvas

Escalates into the full workbench overlay. With something selected, it opens directly on that
entry; with nothing selected, it opens the **App page** (below), landing on the route you were
just viewing.

## The App page

The App page is a canvas entry — alongside your component sets — that shows your app's **actual
current route, live**, in a frame. Because it's injected mode, that frame is served by the same
dev server as everything else: real data, your real router, your real auth, not a static
snapshot.

- A route bar above the frame shows the current path, editable, with **Reload** and **Open in
  new tab** actions.
- **Select** and **Edit text** work inside the frame exactly as they do on the top-level page —
  a component rendered inside a flow screen or a nested route gets the same selection chip and
  inline text editing.
- Interacting inside the frame navigates the frame, never your top-level browser tab.
- Collapsing the workbench returns you to the untouched live app; the App page never mutates
  your app's real URL or state.

The App page only appears in injected mode's sidebar — there's no running app for it to show in
host mode, so the entry is simply absent rather than shown disabled.

## When to reach for which

- **Something small, right where you're looking** — page tools. No context switch, no losing
  your place in the app.
- **Comparing variants, or working through a whole component set** — the full canvas. See
  [Canvas & flows](/concepts/canvas-and-flows/).
- **Both use the same underlying selection, text-adapter, and agent plumbing** — see
  [Selection & drill-in](/concepts/selection/), [Text & i18next](/adapters/text/), and
  [The Pi agent](/concepts/agent/).
