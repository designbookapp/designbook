---
title: The full view
description: The one designbook UI — the pencil/play entry point, the left rail, the running-app center, and the right panel.
---

There is one designbook UI. It opens over your running app, shows your app live in the
center, and puts every tool — chat, changesets, tokens, flags, selection, code — in chrome
around it. There's no separate canvas to browse and no collapsed toolbar mode; everything
described on this page is always the same view.

## Enter and exit

A round **pencil button** in the bottom-left corner of your running app opens the full view.
A **play button** in the exact same spot closes it and returns you to your app, untouched —
closing never reloads or navigates your app; it just hides the chrome. In injected mode this
is a real expand/collapse of the overlay the plugin adds to your page; in host mode (no app to
inject into) it's designbook's own equivalent toggle.

## Layout

```
┌───┬──────────────┬───────────────────────────────────────┬────────────┐
│   │              │  [branch ▾]      top bar: theme / tenant / …  ⬦   │
│ ▤ │  left panel  │  ─────────────────────────────────────────────── │
│ ▤ │  (Chat /     │                                                   │
│ ▤ │   Changes /  │              your running app, live               │
│ ▤ │   Tokens /   │                                                   │
│   │   Flags)     │  ─────────────────────────────────────────────── │
│   │              │  footer: select · text · (draw · comment)         │
└───┴──────────────┴───────────────────────────────────────┴────────────┘
  rail                        center                          right panel
                                                           (Props | Code)
```

- **Left icon rail** — four sections: **Chat**, **Changes**, **Tokens**, **Flags**. Clicking a
  section switches the left panel to it; clicking the active section's icon again collapses
  the panel. See [Chat & the Pi agent](/concepts/agent/), [Changesets & the Changes
  panel](/concepts/changesets/), [Theme](/adapters/theme/), and [Flags](/adapters/flags/).
- **Left panel head** — a branch dropdown (unlabeled, showing the current git branch) backed
  by real [worktrees](/branch-instances/): switching branches here does a real checkout, not a
  preview.
- **Center** — your app, live, hot-reloading through your real dev server (or designbook's
  embedded one in host mode) — not a mock and not a second render of your components inside
  designbook's own tree. A **top bar** carries one compact, unlabeled picker per registered
  [adapter dimension](/adapters/overview/) — theme, tenant, language, light/dark, and so on —
  plus desktop/tablet/mobile viewport width controls on the right. Dimensions beyond a handful
  collapse into a "+N" popover so a many-dimension app never crowds the bar. A **footer tool
  picker** holds the two active tools, **Select** and **Edit text** (see [Selection &
  drill-in](/concepts/selection/) and [Text & i18next](/adapters/text/)); a draw tool and a
  comment tool sit next to them, visibly disabled — not shipped yet.
- **Right panel** — **Props** and **Code** tabs for whatever is currently selected. See [Props
  panel](/concepts/props-panel/) and [Code panel](/concepts/code-panel/).

Both side panels are collapsible (the icon buttons at the ends of the top bar) and
drag-resizable from their inner edge; widths persist across reloads.

## Selecting inside the app

The center frame isn't a static screenshot — with the **Select** tool active, you click
anywhere in your live app, including inside nested routes and modals, and the hit feeds the
Props panel, the Code panel, and whatever you type into chat next. Selection state, tool
state, and panel layout all survive a page reload.

## What replaced

If you used an earlier designbook version: the `◈ designbook` toolbar **pill**, its compact
**tool strip** for editing directly on the page, the separate **App page** canvas entry, and
the **infinite canvas** of registered components you panned and zoomed around are all gone,
folded into this one view. Component registration (`sets` in your config) still matters — see
[Component registration](/concepts/component-sets/) — but it's no longer a browsable gallery;
it's how designbook names things and finds their source.
