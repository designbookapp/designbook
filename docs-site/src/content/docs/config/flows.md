---
title: Flows (deprecated)
description: The top-level flows config field is a no-op — the screen-sequence UI it powered was retired with the component canvas.
---

`flows` (`Flow[]`, at the top level of `defineConfig`) is **deprecated and a no-op**. It used
to arrange screens into a user-journey view alongside the retired component canvas; that UI is
gone, and nothing in the current full view reads `flows`. The field still type-checks — an
existing config with a `flows` array won't break — but there's nothing left to teach: don't add
new entries.

To review a real user journey today, use [Chat](/concepts/agent/) and
[selection](/concepts/selection/) directly on your running app — walk the actual route, select
what you want to change.
