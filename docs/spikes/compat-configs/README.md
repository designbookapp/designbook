# Compat-spike configs

The designbook configs (+ small upstream edits, as `upstream-changes.patch`)
produced while styling four external repos during the compat spike
(`docs/compat-spike.md`). The clones themselves live untracked in `tmp-repos/`
(external AGPL codebases — never commit them); these extracts are the part
worth keeping. Paths mirror each clone's layout.

Upstream commits the configs were written against:

| Repo | Commit | Date |
| --- | --- | --- |
| calcom | `032962f5775d64959cce9fd2708c27f0b1b0cabe` | 2026-07-03 |
| documenso | `50f272be876f14a2e22518552f5030c3117c3391` | 2026-07-02 |
| twenty | `a4ed561e115b4bd78f9390cde4cc33fa202408f7` | 2026-07-05 |
| excalidraw | `51ca8abde450e44f8f0db1b2708e0408915c7ab1` | 2026-07-03 |

To rebuild a clone: shallow-clone the repo at (or near) that commit into
`tmp-repos/<name>`, copy the files back in, apply the patch if present.

Notes:
- `excalidraw/designbook-spike/` is the S1 injected-workbench spike harness
  (`docs/spikes/s1-injected-workbench.md`), predating the real plugin.
- `documenso/designbook.css.agentB-bak` is the styling agent's backup name,
  kept as found.
- excalidraw's patch contains write-through test edits (Card.scss, en.json),
  documenso's is the lockfile change from installing designbook.
