#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion core seam guard (A-4: the grep core checks).
# Fails if termixion-core contains a platform cfg selector or std::os in real (non-comment) code.
#
# Reads the INDEX (staged) content via `git show :<path>` — so as a pre-commit hook it checks exactly
# what is being committed (not the working tree), and in CI/standalone (index == HEAD after checkout)
# it checks the committed tree. D-1 hardens further: a cargo-metadata forbidden-dependency scan
# (tauri, portable-pty, cocoa/objc/core-foundation, libc, nix, windows*) + wiring it as a CI gate.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Tracked core source files (present in the index).
files="$(git ls-files -- 'crates/termixion-core/src' | grep -E '\.rs$' || true)"
[ -z "$files" ] && { echo "check-core-seam: no termixion-core source files."; exit 0; }

# A violation line (after stripping // comments) is either:
#   - a cfg / cfg! / cfg_attr attribute/macro that mentions a platform selector
#     (target_os/target_family/target_env/target_arch/target_vendor/target_pointer_width, or bare
#      unix/windows) — this catches nested forms like cfg(any(target_os=...)) and cfg(all(unix,...));
#   - or any use of std::os::.
cfg_line='cfg(_attr)?!?\('
plat_tok='\b(target_os|target_family|target_env|target_arch|target_vendor|target_pointer_width|unix|windows)\b'

matched=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  body="$(git show ":$f" 2>/dev/null | sed 's://.*$::')"
  out="$(printf '%s\n' "$body" | grep -nE "$cfg_line" | grep -E "$plat_tok" || true)"
  out_os="$(printf '%s\n' "$body" | grep -nE 'std::os::' || true)"
  hits="$(printf '%s\n%s\n' "$out" "$out_os" | grep -vE '^$' || true)"
  if [ -n "$hits" ]; then
    [ "$matched" -eq 0 ] && echo "check-core-seam: FORBIDDEN platform-specific code in termixion-core (keep it platform-agnostic):"
    echo "  $f:"
    printf '%s\n' "$hits" | sed 's/^/    /'
    matched=1
  fi
done <<< "$files"

if [ "$matched" -eq 1 ]; then
  exit 1
fi
echo "check-core-seam: OK — no platform cfg / std::os in termixion-core."
