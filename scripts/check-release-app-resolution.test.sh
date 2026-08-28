#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for the release-bundle RESOLUTION guard used by .github/workflows/release.yml
# (trmx-242, grill H8).
#
# The guard exists because `scripts/smoke.sh` line 14 is
# `APP="${1:-target/debug/bundle/macos/Termixion.app}"`, and `${1:-…}` substitutes its default when
# the argument is EMPTY as well as when it is missing. So the issue's sketched
# `smoke.sh "$(find … -print -quit)"` would, on an unmatched find, silently smoke a cached DEBUG
# bundle — and the release gate would pass while testing the artifact it exists to stop shipping.
#
# A real release build only ever produces the one-match case, so the zero- and multiple-match
# branches are covered here against temp fixtures rather than left as review-only claims.
# Run: bash scripts/check-release-app-resolution.test.sh
set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
fails=0

# The resolution logic, character-for-character as the workflow runs it (kept in sync by review;
# a divergence here is exactly what this test is for).
resolve() { # resolve <root>  → echoes the app path, or fails
  ( cd "$1"
    expected="target/release/bundle/macos/Termixion.app"
    matches="$(find target -type d -path '*release/bundle/macos/Termixion.app' -prune -print 2>/dev/null || true)"
    count="$(printf '%s' "$matches" | grep -c . || true)"
    if [ "$count" -ne 1 ]; then
      echo "expected exactly 1 release .app, found $count" >&2
      exit 1
    fi
    app="$matches"
    if [ "$app" != "$expected" ]; then
      echo "resolved '$app' but expected exactly '$expected'" >&2
      exit 1
    fi
    printf '%s' "$app" )
}

check() { # check <label> <root> <expect: pass|fail> [expected-path]
  local label="$1" root="$2" expect="$3" want="${4-}" rc=0 out=""
  out="$(resolve "$root" 2>&1)" || rc=$?
  if [ "$expect" = pass ] && [ "$rc" -ne 0 ]; then
    echo "FAIL: $label — expected success, got exit $rc: $out"; fails=$((fails + 1))
  elif [ "$expect" = fail ] && [ "$rc" -eq 0 ]; then
    echo "FAIL: $label — expected a non-zero exit, got 0 (resolved '$out')"; fails=$((fails + 1))
  elif [ "$expect" = pass ] && [ -n "$want" ] && [ "$out" != "$want" ]; then
    echo "FAIL: $label — resolved '$out', wanted '$want'"; fails=$((fails + 1))
  else
    echo "ok: $label"
  fi
}

# (i) exactly one release bundle — the real-build case.
mkdir -p "$tmp/one/target/release/bundle/macos/Termixion.app"
check "exactly one release .app resolves to the canonical path" "$tmp/one" pass \
  "target/release/bundle/macos/Termixion.app"

# (ii) NONE — the dangerous case. Must fail, never fall through to smoke.sh's debug default.
mkdir -p "$tmp/none/target/debug/bundle/macos/Termixion.app"
check "no release .app FAILS (never falls back to the debug bundle)" "$tmp/none" fail

# (iii) MORE THAN ONE — ambiguous; refuse rather than pick.
mkdir -p "$tmp/many/target/release/bundle/macos/Termixion.app"
mkdir -p "$tmp/many/target/aarch64-apple-darwin/release/bundle/macos/Termixion.app"
check "multiple release .apps FAIL (ambiguous, never guess)" "$tmp/many" fail

# (iv) a debug bundle sitting NEXT TO a release one must not confuse the match.
mkdir -p "$tmp/both/target/release/bundle/macos/Termixion.app"
mkdir -p "$tmp/both/target/debug/bundle/macos/Termixion.app"
check "a debug bundle alongside the release one is ignored" "$tmp/both" pass \
  "target/release/bundle/macos/Termixion.app"

if [ "$fails" -ne 0 ]; then
  echo "check-release-app-resolution.test: $fails case(s) failed." >&2
  exit 1
fi
echo "check-release-app-resolution.test: OK (4 cases)."
