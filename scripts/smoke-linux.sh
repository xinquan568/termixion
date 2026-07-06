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
# Headless webkit2gtk needs coaxing to render in CI (no GPU, no compositor). The incantation:
#   - xvfb with an EXPLICIT screen + depth (the default 8-bit screen is too small for the webview to paint,
#     which silently leaves the sentinel sequence never running → the app's watchdog times out);
#   - APPIMAGE_EXTRACT_AND_RUN=1 (ENV var, not a CLI flag — a flag would reach the app) runs the AppImage
#     without FUSE;
#   - LIBGL_ALWAYS_SOFTWARE forces software GL (no GPU on the runner); GDK_BACKEND=x11 pins the backend;
#     WEBKIT_DISABLE_COMPOSITING_MODE / _DMABUF_RENDERER avoid the headless-webkit GL/DMABUF crashes;
#   - WEBKIT_FORCE_SANDBOX=0 lets webkit run without its bwrap sandbox (blocked/unavailable in CI);
#   - NO_AT_BRIDGE silences the benign AT-SPI accessibility-bus warning.
# `--smoke` is unambiguously the app's own argument. The app's watchdog (90 s, generous for a slow headless
# webkit boot) fails-closed on a genuine hang.
xvfb-run -a --server-args="-screen 0 1280x1024x24" env \
  APPIMAGE_EXTRACT_AND_RUN=1 \
  LIBGL_ALWAYS_SOFTWARE=1 \
  GDK_BACKEND=x11 \
  WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  WEBKIT_FORCE_SANDBOX=0 \
  NO_AT_BRIDGE=1 \
  DIR="$DIR" \
  "$APP" --smoke
echo "smoke-linux: OK — the packaged AppImage's --smoke exited 0"
