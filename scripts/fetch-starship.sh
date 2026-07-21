#!/usr/bin/env bash
# trmx-207: fetch the pinned Starship sidecar for Tauri bundling (tauri.sidecar.conf.json).
#
# The binary is NEVER committed — this runs before every BUNDLING path (release workflow, the CI
# macOS full gate, local `cargo tauri build … --config tauri.sidecar.conf.json`). Plain
# `cargo build`/`test` and `cargo tauri dev` are deliberately sidecar-free.
#
# Trust model (R5): the pinned archive sha256 is the anchor. A verified install writes a marker
# (`<dest>.sha256` = "<version> <binary-sha256>"); reuse REVALIDATES the binary against the
# marker (version + hash) — a missing marker, version bump, or corrupted binary always re-fetches
# and re-verifies. An existing binary is never trusted as-is (round-2 review finding).
#
# Test mode: `--self-test` exercises the reuse/revalidation matrix OFFLINE via a file:// base URL.
set -euo pipefail

STARSHIP_VERSION="${STARSHIP_VERSION:-v1.26.0}"
SHA256_AARCH64="${STARSHIP_SHA256_OVERRIDE:-c40b27b11f580411e068f2fa6c1be7830a387c0bc47a94d1d37f32b054c5361d}"
BASE_URL="${STARSHIP_BASE_URL:-https://github.com/starship/starship/releases/download}"

binary_sha() { shasum -a 256 "$1" | awk '{print $1}'; }

install_verified() { # $1=triple $2=expected_archive_sha $3=dest
  local triple="$1" expected="$2" dest="$3" tmp
  tmp="$(mktemp -d)"
  local url="$BASE_URL/$STARSHIP_VERSION/starship-$triple.tar.gz"
  echo "fetch-starship: downloading $url"
  if ! curl -fsSL -o "$tmp/starship.tar.gz" "$url"; then
    rm -rf "$tmp"
    echo "fetch-starship: download failed for $triple" >&2
    return 1
  fi
  local actual
  actual="$(binary_sha "$tmp/starship.tar.gz")"
  if [[ "$actual" != "$expected" ]]; then
    rm -rf "$tmp"
    echo "fetch-starship: archive sha256 mismatch for $triple (expected $expected, got $actual)" >&2
    return 1
  fi
  tar -xzf "$tmp/starship.tar.gz" -C "$tmp"
  install -m 0755 "$tmp/starship" "$dest.partial"
  printf '%s %s\n' "$STARSHIP_VERSION" "$(binary_sha "$dest.partial")" > "$dest.sha256.partial"
  mv "$dest.partial" "$dest"
  mv "$dest.sha256.partial" "$dest.sha256"
  rm -rf "$tmp"
  echo "fetch-starship: installed $dest ($STARSHIP_VERSION)"
}

fetch() { # $1=triple
  local triple="$1" expected
  case "$triple" in
    aarch64-apple-darwin) expected="$SHA256_AARCH64" ;;
    *) echo "fetch-starship: unsupported target triple '$triple' (release surface is darwin-aarch64; add a pinned sha256 to expand)" >&2; return 1 ;;
  esac
  local dest_dir dest
  dest_dir="$(cd "$(dirname "$0")/.." && pwd)/crates/termixion-tauri/binaries"
  mkdir -p "$dest_dir"
  dest="$dest_dir/starship-$triple"

  # Reuse ONLY a marker-revalidated binary: version + binary hash must both match.
  if [[ -x "$dest" && -f "$dest.sha256" ]]; then
    local marker_version marker_hash
    read -r marker_version marker_hash < "$dest.sha256" || true
    if [[ "$marker_version" == "$STARSHIP_VERSION" && "$marker_hash" == "$(binary_sha "$dest")" ]]; then
      echo "fetch-starship: $dest already present (marker-verified $STARSHIP_VERSION)"
      return 0
    fi
    echo "fetch-starship: existing binary fails revalidation (version/hash drift) — re-fetching"
  elif [[ -e "$dest" ]]; then
    echo "fetch-starship: existing binary has no verification marker — re-fetching"
  fi
  install_verified "$triple" "$expected" "$dest"
}

self_test() {
  echo "fetch-starship: --self-test (offline)"
  local t
  t="$(mktemp -d)"
  # A fake repo layout so BASE_URL/file:// resolves like the GitHub releases path.
  mkdir -p "$t/repo/scripts" "$t/repo/crates/termixion-tauri" "$t/serve/vX.Y.Z-test"
  cp "$0" "$t/repo/scripts/fetch-starship.sh"
  printf '#!/bin/sh\necho fake-starship\n' > "$t/serve/starship"
  chmod +x "$t/serve/starship"
  tar -czf "$t/serve/vX.Y.Z-test/starship-aarch64-apple-darwin.tar.gz" -C "$t/serve" starship
  local sha dest
  sha="$(shasum -a 256 "$t/serve/vX.Y.Z-test/starship-aarch64-apple-darwin.tar.gz" | awk '{print $1}')"
  dest="$t/repo/crates/termixion-tauri/binaries/starship-aarch64-apple-darwin"
  run_case() { # $1=case name
    STARSHIP_VERSION="vX.Y.Z-test" STARSHIP_SHA256_OVERRIDE="$sha" \
      STARSHIP_BASE_URL="file://$t/serve" bash "$t/repo/scripts/fetch-starship.sh" \
      aarch64-apple-darwin > "$t/out" 2>&1 || { echo "self-test FAILED ($1):"; cat "$t/out"; exit 1; }
  }
  # 1. Fresh install.
  run_case "fresh install"
  grep -q "installed" "$t/out" || { echo "self-test FAILED: no install"; exit 1; }
  [[ -f "$dest.sha256" ]] || { echo "self-test FAILED: no marker"; exit 1; }
  # 2. Valid-marker reuse — prove NO re-download by removing the served archive.
  mv "$t/serve/vX.Y.Z-test" "$t/serve/.hidden"
  run_case "marker reuse"
  grep -q "marker-verified" "$t/out" || { echo "self-test FAILED: expected marker reuse"; exit 1; }
  mv "$t/serve/.hidden" "$t/serve/vX.Y.Z-test"
  # 3. Binary present but marker MISSING → full revalidation re-fetch (never trusted as-is).
  rm "$dest.sha256"
  run_case "missing marker"
  grep -q "no verification marker" "$t/out" || { echo "self-test FAILED: missing-marker path"; exit 1; }
  grep -q "installed" "$t/out" || { echo "self-test FAILED: missing-marker re-fetch"; exit 1; }
  # 4. Version-mismatch marker → re-fetch.
  printf 'v0.0.0-stale %s\n' "$(shasum -a 256 "$dest" | awk '{print $1}')" > "$dest.sha256"
  run_case "version mismatch"
  grep -q "fails revalidation" "$t/out" || { echo "self-test FAILED: version-mismatch path"; exit 1; }
  # 5. Corrupted binary (marker hash mismatch) → re-fetch.
  printf 'corrupted' >> "$dest"
  run_case "corrupted binary"
  grep -q "fails revalidation" "$t/out" || { echo "self-test FAILED: corruption path"; exit 1; }
  grep -q "installed" "$t/out" || { echo "self-test FAILED: corruption re-fetch"; exit 1; }
  rm -rf "$t"
  echo "fetch-starship: self-test OK (5/5 scenarios)"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
else
  fetch "${1:-aarch64-apple-darwin}"
fi
