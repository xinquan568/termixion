#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Resolve THE release .app bundle, or fail (trmx-242, grill H8). Prints the path on stdout.
#
# This exists because `scripts/smoke.sh` line 14 is
# `APP="${1:-target/debug/bundle/macos/Termixion.app}"`, and `${1:-…}` substitutes its default when
# the argument is EMPTY as well as when it is missing. So `smoke.sh "$(find … -print -quit)"` would,
# on an unmatched find, silently smoke a cached DEBUG bundle — the release gate passing while
# testing the very artifact it exists to stop shipping.
#
# It is a SCRIPT rather than inline workflow YAML so that release.yml and
# scripts/check-release-app-resolution.test.sh exercise the SAME code. An inline copy plus a test that
# re-implements it can drift apart silently, leaving the test green while the real gate rots.
#
# Usage: resolve-release-app.sh [root]   (root defaults to the repo root)
set -euo pipefail

root="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$root"

expected="target/release/bundle/macos/Termixion.app"
matches="$(find target -type d -path '*release/bundle/macos/Termixion.app' -prune -print)"
count="$(printf '%s' "$matches" | grep -c . || true)"

if [ "$count" -ne 1 ]; then
  echo "resolve-release-app: expected exactly 1 release .app, found $count:" >&2
  printf '%s\n' "$matches" | sed 's/^/    /' >&2
  exit 1
fi
if [ "$matches" != "$expected" ]; then
  echo "resolve-release-app: resolved '$matches' but expected exactly '$expected'" >&2
  exit 1
fi
printf '%s' "$matches"
