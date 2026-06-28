#!/usr/bin/env bash
# check-release-metadata (E-2a): assert the release identity is exactly what a v0.0.1 tag should ship,
# so the artifact is correctly versioned, named, and identified. The version source of truth is the
# workspace Cargo.toml [workspace.package] version; app/package.json and tauri.conf.json must match it.
# The bundle identity (identifier + product name) is pinned to constants here — changing it must be a
# deliberate edit to BOTH tauri.conf.json and this script, so drift can't slip through.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Pinned bundle identity — must match crates/termixion-tauri/tauri.conf.json.
EXPECTED_IDENTIFIER="dev.termixion.app"
EXPECTED_PRODUCT="Termixion"

fail() {
  echo "release-metadata: FAIL — $*" >&2
  exit 1
}

# First "key": "value" string field from a JSON-ish file (sufficient for these flat top-level fields).
json_str() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -1; }

conf="crates/termixion-tauri/tauri.conf.json"

# Source of truth: the `version` inside the [workspace.package] table (scoped, so an unrelated bare
# `version = ` line elsewhere can never be mistaken for it).
workspace_version="$(awk '
  /^\[workspace\.package\]/ { in_sec = 1; next }
  /^\[/ { in_sec = 0 }
  in_sec && /^[[:space:]]*version[[:space:]]*=/ {
    if (match($0, /"[^"]*"/)) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
  }
' Cargo.toml)"
[ -n "$workspace_version" ] || fail "could not read [workspace.package] version from Cargo.toml"

app_version="$(json_str app/package.json version)"
[ "$app_version" = "$workspace_version" ] ||
  fail "app/package.json version ($app_version) != workspace ($workspace_version)"

conf_version="$(json_str "$conf" version)"
[ "$conf_version" = "$workspace_version" ] ||
  fail "tauri.conf.json version ($conf_version) != workspace ($workspace_version)"

identifier="$(json_str "$conf" identifier)"
[ "$identifier" = "$EXPECTED_IDENTIFIER" ] ||
  fail "tauri.conf.json identifier ($identifier) != $EXPECTED_IDENTIFIER"

product="$(json_str "$conf" productName)"
[ "$product" = "$EXPECTED_PRODUCT" ] ||
  fail "tauri.conf.json productName ($product) != $EXPECTED_PRODUCT"

# The v0.0.1 release artifact name. NOTE: local `cargo tauri build` bundles `app` only
# (bundle.targets=["app"]); the `.dmg` is produced by the E-2 release pipeline, which must enable the
# `dmg` bundle target. v0.0.1 ships only the Apple-silicon build (Q-g reference Mac = M1 Pro).
asset="${product}_${workspace_version}_aarch64.dmg"

echo "release-metadata: OK — version $workspace_version aligned (Cargo / app / tauri.conf);" \
  "identifier=$identifier productName=$product"
echo "release-metadata: E-2 release artifact name = $asset (built with the dmg bundle target in E-2)"
