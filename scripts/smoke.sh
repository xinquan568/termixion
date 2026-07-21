#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion end-to-end smoke runner (C-3 / P0-4 / D-3). Sets up the DETERMINISTIC sentinel and runs the
# PACKAGED app's `--smoke` mode — which drives `pwd` / `cd "$DIR"` / `pwd` / `ls` over the production
# Tauri channel (C-2), reads the results back from the webview, and asserts (a) cwd became `$DIR` and
# (b) `ls` listed `SMOKE_OK`, then exits 0/1. This script exits 0 only if that app run exited 0.
#
# Usage: scripts/smoke.sh [path-to-Termixion-binary]
#   default: target/debug/bundle/macos/Termixion.app (workspace target; a .app or a direct binary)
#   build it first with:  (cd crates/termixion-tauri && cargo tauri build --debug)
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

APP="${1:-target/debug/bundle/macos/Termixion.app}"
# Accept a .app bundle or a direct binary. The bundle's MAIN executable comes from
# CFBundleExecutable — Contents/MacOS/ also carries sidecars since trmx-207 (starship), so a
# first-executable glob would pick the wrong binary (the exact CI failure this replaces).
if [ -d "$APP" ]; then
  main="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || true)"
  if [ -n "$main" ] && [ -x "$APP/Contents/MacOS/$main" ]; then
    APP="$APP/Contents/MacOS/$main"
  else
    # Plist unavailable: fall back to the sole executable, refusing ambiguity.
    count="$(find "$APP/Contents/MacOS" -maxdepth 1 -type f -perm -111 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$count" != "1" ]; then
      echo "smoke: cannot determine the main executable in $APP (CFBundleExecutable unreadable, $count candidates)" >&2
      exit 2
    fi
    APP="$(find "$APP/Contents/MacOS" -maxdepth 1 -type f -perm -111 2>/dev/null | head -1)"
  fi
fi
if [ ! -x "$APP" ]; then
  echo "smoke: app/binary not found: $APP" >&2
  echo "smoke: build it with  (cd crates/termixion-tauri && cargo tauri build --debug)" >&2
  exit 2
fi

# A unique sentinel dir holding SMOKE_OK — no hard-coded /tmp path, no "some known entry" (Q2/F2).
DIR="$(mktemp -d)/termixion-smoke"
mkdir -p "$DIR"
# Canonicalize to the PHYSICAL path (resolve the macOS /var -> /private/var symlink) so the shell's
# `cd "$DIR"; pwd` prints exactly $DIR — the logical pwd of an already-physical path is that path.
DIR="$(cd "$DIR" && pwd -P)"
touch "$DIR/SMOKE_OK"
cleanup() { rm -rf "$(dirname "$DIR")" 2>/dev/null || true; }
trap cleanup EXIT

echo "smoke: DIR=$DIR — running $APP --smoke"
DIR="$DIR" "$APP" --smoke
echo "smoke: OK — the packaged app's --smoke exited 0"
