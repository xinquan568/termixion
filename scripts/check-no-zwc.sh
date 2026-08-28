#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion "no committed wordcode" gate (trmx-240, L14).
#
# The repo shipped 8 compiled zsh `.zwc` files (996 KB) under the vendored powerlevel10k tree.
# Upstream does not ship them — p10k compiles its own on first load — so they were produced on
# someone's machine and committed. They are also not inert: zsh loads a `.zwc` in preference to the
# `.zsh` beside it whenever the wordcode is not older, so the reviewable text was not what ran.
#
# Everything that executes in a user's shell should be reviewable text with recorded provenance.
# This gate keeps it that way when the vendored trees are next refreshed.
#
# `git ls-files` is a TRACKED-file query by design: a local build artefact nobody committed is not
# this gate's business, and `scripts/check-no-zwc.test.sh` pins that boundary in both directions.
#
# Usage: check-no-zwc.sh [repo-dir]   (defaults to this script's repository)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

found="$(git ls-files -- '*.zwc' || true)"
if [ -n "$found" ]; then
  echo "check-no-zwc: FORBIDDEN committed zsh wordcode (trmx-240):" >&2
  printf '%s\n' "$found" | sed 's/^/    /' >&2
  cat >&2 <<'WHY'
    zsh loads a .zwc in preference to the .zsh beside it, so a committed blob — not the reviewable
    source — is what executes in the user's shell. Vendor the source only; powerlevel10k compiles
    its own wordcode on first load into the (user-writable) materialized version directory.
WHY
  exit 1
fi
echo "check-no-zwc: OK — no committed .zwc."
