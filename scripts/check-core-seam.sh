#!/usr/bin/env bash
# A-1 skeleton placeholder. D-1 implements the real seam guard:
#   (a) `cargo metadata` for termixion-core fails on forbidden deps
#       (tauri, portable-pty, cocoa/objc/core-foundation, libc, nix, windows*);
#   (b) `rg` fails on any platform cfg in termixion-core non-test code —
#       cfg(target_os|target_family|target_env|target_arch|target_vendor|target_pointer_width),
#       bare cfg(unix)/cfg(windows), and std::os::.
# Acceptance (D-1): injecting any of {forbidden dep, cfg(target_os=...), bare cfg(unix)} turns CI red.
set -euo pipefail
echo "check-core-seam.sh: placeholder — implemented in task D-1."
