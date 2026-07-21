#!/usr/bin/env bash
# trmx-207: fetch the pinned Starship sidecar for Tauri bundling (externalBin).
#
# The binary is NEVER committed — this script runs before every bundling path (the release
# workflow's tauri-action step, and locally before `cargo tauri build`/`dev`). Plain
# `cargo build`/`cargo test` never need it. Pinned version + sha256 (supply-chain hygiene, R5).
set -euo pipefail

STARSHIP_VERSION="v1.26.0"
# sha256 of starship-aarch64-apple-darwin.tar.gz for v1.26.0 (verify on version bumps:
# https://github.com/starship/starship/releases — the .sha256 assets published per artifact).
SHA256_AARCH64="c40b27b11f580411e068f2fa6c1be7830a387c0bc47a94d1d37f32b054c5361d"

triple="${1:-aarch64-apple-darwin}"
case "$triple" in
  aarch64-apple-darwin) expected="$SHA256_AARCH64" ;;
  *) echo "fetch-starship: unsupported target triple '$triple' (release surface is darwin-aarch64; add a pinned sha256 to expand)" >&2; exit 1 ;;
esac

dest_dir="$(cd "$(dirname "$0")/.." && pwd)/crates/termixion-tauri/binaries"
dest="$dest_dir/starship-$triple"
if [[ -x "$dest" ]]; then
  echo "fetch-starship: $dest already present"
  exit 0
fi

mkdir -p "$dest_dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
url="https://github.com/starship/starship/releases/download/$STARSHIP_VERSION/starship-$triple.tar.gz"
echo "fetch-starship: downloading $url"
curl -fsSL -o "$tmp/starship.tar.gz" "$url"

actual="$(shasum -a 256 "$tmp/starship.tar.gz" | awk '{print $1}')"
if [[ "$actual" != "$expected" ]]; then
  echo "fetch-starship: sha256 mismatch for $triple (expected $expected, got $actual)" >&2
  exit 1
fi

tar -xzf "$tmp/starship.tar.gz" -C "$tmp"
install -m 0755 "$tmp/starship" "$dest"
echo "fetch-starship: installed $dest ($STARSHIP_VERSION)"
