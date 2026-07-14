#!/usr/bin/env bash
#
# publish-public.sh — generate the PUBLIC-repo subset from this private repo.
#
# Model (see docs/oss-launch.md): this repo is the private source of truth with
# full history. The public repo (designbookapp/designbook) is a GENERATED subset
# — nothing is authored there. This script snapshots the allowlisted paths from a
# committed ref into a clean tree, so internal files (docs/specs, marketing/, …)
# never leak and your local workflow never changes.
#
#   ./scripts/publish-public.sh                      # dry run → staging dir + manifest
#   ./scripts/publish-public.sh --staging /tmp/pub   # dry run into a chosen dir
#   ./scripts/publish-public.sh --ref v0.3.0         # snapshot a tag instead of HEAD
#   PUBLIC_REPO_DIR=../designbook-public \
#     ./scripts/publish-public.sh --publish --message "release: v0.3.0"
#
# Publishes from a COMMITTED ref (default HEAD), never the dirty working tree —
# so uncommitted local WIP is never shipped.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOWLIST="$REPO_ROOT/scripts/public-allowlist.txt"

MODE="dry-run"
REF="HEAD"
STAGING=""
MESSAGE=""
ASSUME_YES="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --publish) MODE="publish" ;;
    --staging) STAGING="${2:?--staging needs a path}"; shift ;;
    --ref)     REF="${2:?--ref needs a ref}"; shift ;;
    --message) MESSAGE="${2:?--message needs text}"; shift ;;
    --yes)     ASSUME_YES="yes" ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -f "$ALLOWLIST" ] || { echo "missing allowlist: $ALLOWLIST" >&2; exit 1; }
[ -n "$STAGING" ] || STAGING="$(mktemp -d)/public"

# --- read allowlist into a pathspec array (bash 3.2 compatible) ------------
pathspecs=()
while IFS= read -r line; do
  pathspecs+=("$line")
done < <(grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" | sed 's/[[:space:]]*$//')
[ "${#pathspecs[@]}" -gt 0 ] || { echo "allowlist is empty" >&2; exit 1; }

echo "==> snapshotting ref '$REF' → $STAGING"
rm -rf "$STAGING"; mkdir -p "$STAGING"
# git archive honors :(exclude) pathspec magic and emits ONLY tracked files —
# gitignored/untracked scratch is inherently absent.
git -C "$REPO_ROOT" archive "$REF" -- "${pathspecs[@]}" | tar -x -C "$STAGING"

# --- transforms: strip package.json scripts that reference allowlist-excluded
# paths (dogfood/, examples/mono-app) so the public tree has no 404 scripts.
# The private tree keeps them — this rewrites the STAGED copies only.
node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const strip = (file, keys) => {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const key of keys) delete pkg.scripts?.[key];
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  };
  strip(process.argv[1] + "/package.json", ["dogfood", "example:mono"]);
  strip(process.argv[1] + "/packages/designbook/package.json", ["dogfood"]);
' "$STAGING"
echo "==> stripped private-only scripts (dogfood, example:mono) from staged package.json"

# --- fail-closed safety scan (defense-in-depth on top of default-deny) -----
fail=0
scan() { (cd "$STAGING" && find . -type f | sed 's#^\./##'); }

leaks="$(scan | grep -iE '(^|/)(docs/(specs|spikes|drafts|superpowers|roadmap|monetization|compat-spike|runtime-topology|oss-launch)|marketing/|AUTH-NOTES|\.designbook/)' || true)"
if [ -n "$leaks" ]; then
  echo "!! INTERNAL PATHS in staging (allowlist too broad):" >&2; echo "$leaks" | sed 's/^/   /' >&2; fail=1
fi

envs="$(cd "$STAGING" && find . -type f -name '.env*' ! -name '*.example' | sed 's#^\./##' || true)"
if [ -n "$envs" ]; then
  echo "!! .env FILES in staging:" >&2; echo "$envs" | sed 's/^/   /' >&2; fail=1
fi

secrets="$(cd "$STAGING" && grep -rIlE 'sk-ant-[A-Za-z0-9]|ANTHROPIC_API_KEY[[:space:]]*=[[:space:]]*[\"'\'']?sk|BEGIN [A-Z ]*PRIVATE KEY' . 2>/dev/null | sed 's#^\./##' || true)"
if [ -n "$secrets" ]; then
  echo "!! POSSIBLE SECRETS in staging:" >&2; echo "$secrets" | sed 's/^/   /' >&2; fail=1
fi

[ "$fail" -eq 0 ] || { echo "aborting — safety scan failed." >&2; exit 1; }

# --- manifest --------------------------------------------------------------
count="$(scan | wc -l | tr -d ' ')"
size="$(du -sh "$STAGING" | awk '{print $1}')"
manifest="$STAGING/../MANIFEST.txt"
scan | sort > "$manifest"
echo
echo "==> would ship $count files ($size). full list: $manifest"
echo "==> top-level:"
(cd "$STAGING" && for e in $(ls -A); do
  if [ -d "$e" ]; then printf '   %-24s %s files\n' "$e/" "$(find "$e" -type f | wc -l | tr -d ' ')";
  else printf '   %-24s (file)\n' "$e"; fi
done)
echo "==> safety scan: clean (no internal paths / .env / secrets)"

if [ "$MODE" = "dry-run" ]; then
  echo
  echo "dry run only. inspect: $STAGING"
  echo "to publish: PUBLIC_REPO_DIR=<clone> $0 --publish --message '…'"
  exit 0
fi

# --- publish mode (regenerate public tree = handles adds/mods/deletes) -----
: "${PUBLIC_REPO_DIR:?--publish needs PUBLIC_REPO_DIR=<path to public repo clone>}"
PUB="$(cd "$PUBLIC_REPO_DIR" && pwd)"
git -C "$PUB" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "$PUB is not a git repo" >&2; exit 1; }
[ -n "$MESSAGE" ] || { echo "--publish needs --message" >&2; exit 1; }

echo "==> regenerating public tree in $PUB"
# wipe tracked files (keep .git), then lay down the snapshot fresh
git -C "$PUB" rm -rq --ignore-unmatch . >/dev/null 2>&1 || true
(cd "$STAGING" && tar -c .) | tar -x -C "$PUB"
git -C "$PUB" add -A
echo "==> public diff (staged):"
git -C "$PUB" -c color.ui=always diff --cached --stat | tail -30

if [ "$ASSUME_YES" != "yes" ]; then
  printf "commit + note: NOT pushing. Run smoke (pnpm install/build/test) in %s, then 'git commit'/'git push' yourself, or re-run with --yes.\n" "$PUB"
  exit 0
fi
git -C "$PUB" commit -m "$MESSAGE"
echo "==> committed to $PUB (NOT pushed). Verify + 'git push' manually."
