#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion secret scan (A-4). Refuses obvious credentials / keys in STAGED content (the pre-commit hook) or,
# with `--range <a>...<b>`, in a commit range (CI runs it over the PR / push diff — trmx-234).
# Pairs with the .gitignore patterns (*.p12 / *.p8 / *.pem / *.key). Self-test: scripts/secret-scan.test.sh.
# Exit: 0 clean · 1 secret found · 2 usage / unresolvable range (never a vacuous pass).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

mode="staged"; range=""
case "${1:-}" in
  --range)
    range="${2:-}"
    [ -n "$range" ] || { echo "secret-scan: usage: secret-scan.sh [--range <a>...<b>]"; exit 2; }
    mode="range";;
  "") ;;
  *) echo "secret-scan: unknown option '$1' (usage: secret-scan.sh [--range <a>...<b>])"; exit 2;;
esac

if [ "$mode" = "range" ]; then
  if ! files="$(git diff --name-only --diff-filter=ACM "$range" 2>/dev/null)"; then
    echo "secret-scan: cannot resolve range '$range' (fetch the base ref, e.g. checkout with fetch-depth: 0)"; exit 2
  fi
  added="$(git diff --diff-filter=ACM -U0 "$range" | grep -E '^\+' | grep -vE '^\+\+\+' || true)"
  [ -z "$files" ] && { echo "secret-scan: no changed files in $range."; exit 0; }
else
  files="$(git diff --cached --name-only --diff-filter=ACM || true)"
  [ -z "$files" ] && { echo "secret-scan: no staged files."; exit 0; }
  added="$(git diff --cached --diff-filter=ACM -U0 | grep -E '^\+' | grep -vE '^\+\+\+' || true)"
fi

fail=0

# 1. Forbidden credential file types, even added by accident.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.p12|*.p8|*.pem|*.key|*.mobileprovision|*.cer)
      echo "secret-scan: refusing to commit credential file: $f"; fail=1;;
  esac
done <<< "$files"

# 2. Secret-looking content in the added lines.
if printf '%s\n' "$added" | grep -nE \
  'AKIA[0-9A-Z]{16}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}' \
  >/dev/null; then
  echo "secret-scan: a line looks like a secret (AWS key / private key / GitHub or Slack token). Refusing."
  fail=1
fi

[ "$fail" -eq 0 ] && echo "secret-scan: OK ($mode)."
exit "$fail"
