#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion ISC-header check (A-4). New source files must carry the ISC SPDX header.
# Scope: newly-ADDED .rs/.ts/.tsx files (config files like *.json/*.js are exempt).
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

added="$(git diff --cached --name-only --diff-filter=A | grep -E '\.(rs|ts|tsx)$' || true)"
[ -z "$added" ] && { echo "isc-header: no new source files."; exit 0; }

fail=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # Read the STAGED (index) content, not the working tree, so the check reflects what is committed.
  if ! git show ":$f" 2>/dev/null | head -3 | grep -q 'SPDX-License-Identifier: ISC'; then
    echo "isc-header: new source file missing 'SPDX-License-Identifier: ISC': $f"
    fail=1
  fi
done <<< "$added"

[ "$fail" -eq 0 ] && echo "isc-header: OK."
exit "$fail"
