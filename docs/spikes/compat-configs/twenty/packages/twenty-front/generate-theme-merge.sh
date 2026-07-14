#!/usr/bin/env bash
# Regenerates designbook.theme.merged.css from twenty-ui's real per-mode theme
# files. designbook's themeAdapter takes ONE css `source` path + reads all
# `modes` selectors from that single file's content — it has no per-mode
# source/write-target option, so it can't point at twenty-ui's two separate
# files (theme-light.css has only `.light{}`, theme-dark.css has only
# `.dark{}`) directly. This concatenation is the config-level workaround: run
# this script whenever twenty-ui's theme files change upstream.
#
# NOTE: canvas token edits persist to THIS merged file (via `POST /api/style`,
# the adapter's only write target), not back to the two real per-mode files —
# documented SDK gap, see the round-3 compat-spike report.
set -euo pipefail
cd "$(dirname "$0")"
cat ../twenty-ui/src/theme-constants/theme-light.css \
    ../twenty-ui/src/theme-constants/theme-dark.css \
    > designbook.theme.merged.css
