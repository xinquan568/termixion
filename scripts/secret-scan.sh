#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion secret scan (A-4). Scans STAGED content; refuses obvious credentials / keys.
# Pairs with the .gitignore patterns (*.p12 / *.p8 / *.pem / *.key). CI (E-1) runs the same script.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

staged="$(git diff --cached --name-only --diff-filter=ACM || true)"
[ -z "$staged" ] && { echo "secret-scan: no staged files."; exit 0; }

fail=0

# 1. Forbidden credential file types, even staged by accident.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.p12|*.p8|*.pem|*.key|*.mobileprovision|*.cer)
      echo "secret-scan: refusing to commit credential file: $f"; fail=1;;
  esac
done <<< "$staged"

# 2. Secret-looking content in the staged diff (added lines).
added="$(git diff --cached --diff-filter=ACM -U0 | grep -E '^\+' | grep -vE '^\+\+\+' || true)"
if printf '%s\n' "$added" | grep -nE \
  'AKIA[0-9A-Z]{16}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}' \
  >/dev/null; then
  echo "secret-scan: a staged line looks like a secret (AWS key / private key / GitHub or Slack token). Refusing."
  fail=1
fi

[ "$fail" -eq 0 ] && echo "secret-scan: OK."
exit "$fail"
