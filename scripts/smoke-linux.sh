#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion end-to-end smoke runner for LINUX (trmx-102, FR-1.7). The Linux sibling of scripts/smoke.sh:
# same DETERMINISTIC `DIR` sentinel + the packaged app's `--smoke` mode (which drives pwd/cd/ls over the
# production Tauri channel and exits 0/1 — platform-agnostic webview logic), but it runs the built
# AppImage under a virtual X server (webkit2gtk needs a display) with the headless-webkit env quirks.
#
# Usage: scripts/smoke-linux.sh [path-to-AppImage]
#   default: the first target/debug/bundle/appimage/*.AppImage
#   build it first with:  (cd crates/termixion-tauri && cargo tauri build --debug --bundles appimage)
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

APP="${1:-}"
if [ -z "$APP" ]; then
  APP="$(find target/debug/bundle/appimage -maxdepth 1 -type f -name '*.AppImage' 2>/dev/null | head -1)"
fi
if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  echo "smoke-linux: AppImage not found (looked in target/debug/bundle/appimage/*.AppImage)" >&2
  echo "smoke-linux: build it with  (cd crates/termixion-tauri && cargo tauri build --debug --bundles appimage)" >&2
  exit 2
fi
chmod +x "$APP" || true

# A unique sentinel dir holding SMOKE_OK. Canonicalize to the physical path so `cd "$DIR"; pwd` matches.
DIR="$(mktemp -d)/termixion-smoke"
mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd -P)"
touch "$DIR/SMOKE_OK"
cleanup() { rm -rf "$(dirname "$DIR")" 2>/dev/null || true; }
trap cleanup EXIT

echo "smoke-linux: DIR=$DIR — running $APP --smoke under xvfb"
# APPIMAGE_EXTRACT_AND_RUN=1 (ENV var, not a CLI flag — the flag would reach the app) runs the AppImage
# without FUSE; the WEBKIT_DISABLE_* flags avoid the headless-webkit2gtk GL/DMABUF compositing crashes.
# `--smoke` is unambiguously the app's own argument. The app's 30 s watchdog fails-closed on a hang.
xvfb-run -a env \
  APPIMAGE_EXTRACT_AND_RUN=1 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  DIR="$DIR" \
  "$APP" --smoke
echo "smoke-linux: OK — the packaged AppImage's --smoke exited 0"
