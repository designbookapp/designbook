# Figma bridge auth — deferred design note

**Status:** NOT implemented. The bridge currently accepts any localhost connection with no auth. Risk judged low because everything runs locally (2026-07-04). Revisit before any non-local or shared use.

## The two assets, two directions

The dangerous capability (write access to the Figma document) lives in the **plugin**, which executes whatever `invoke` the server sends. So there are two separate things to protect:

1. **The Figma document** — the *plugin* must trust the *server*. A rogue local process could squat a port, answer `/api/figma-hello`, and drive create/modify/delete against the real document (the plugin connects to whoever replies first on the 8787–8797 probe). Guard = **plugin authenticates server**; human judgment belongs in the **plugin UI (inside Figma)**, next to the asset.
2. **designbook / Pi / the codebase** — the *server* must trust the *client*. A rogue client can't touch Figma but receives Pi's `invoke` messages and can feed fake design data back that Pi may write into code. Guard = **server authenticates client**; confirm in the workbench.

An earlier "one-click consent in the workbench" idea only covers #2 — it does nothing for #1 (Figma).

## Realistic-threat wrinkle

WebSocket has no same-origin rule, so a malicious **web page** can open `ws://localhost:8787` and impersonate the plugin → hits #2 (a real remote attacker). It cannot impersonate a *server* or control the plugin, so attacking Figma (#1) needs already-running local native malware — a higher bar.

## Recommended approach when we do it

Don't pick a direction — **one short-lived shared secret used as a mutual challenge** authenticates both sides at once (plugin must present it to connect; server must prove it holds it before the plugin obeys). Put the human confirmation in the **plugin UI**, since the asset we most care about (the Figma doc) sits there.
