#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion core seam guard (A-4 + D-1). Keeps termixion-core platform-agnostic. Two gates:
#   (a) forbidden-dependency scan — termixion-core's resolved dependency graph (all targets, all
#       features) must contain NO platform crate (tauri, portable-pty, cocoa/objc/core-foundation/
#       core-graphics, libc, nix, windows*/winapi). Fails CLOSED if cargo can't resolve.
#   (b) source scan — no platform cfg selector (target_os/family/env/arch/vendor/pointer_width, or bare
#       unix/windows) and no std::os (in any import shape) in core source.
# Both gates read the WORKING TREE; under CI (a fresh checkout) that IS the committed tree — the
# authoritative required gate — so the two scans always agree there. (A pre-commit hook therefore also
# flags unstaged core changes, which fails closed and is fine.)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# (a) Forbidden-dependency scan: `--target all --all-features` resolves cfg-gated and feature-gated
# deps too, so a platform crate hidden behind `[target.'cfg(windows)'.dependencies]` or an optional
# feature can't slip past. The denylist matches whole crate families (-sys / -foundation / -targets).
if command -v cargo >/dev/null 2>&1; then
  forbidden_re='^(tauri([_-].*)?|portable-pty([_-].*)?|cocoa([_-].*)?|objc2?([_-].*)?|core-foundation([_-].*)?|core-graphics([_-].*)?|libc|nix|windows([_-].*)?|winapi([_-].*)?)$'
  # Fail CLOSED: if cargo can't resolve the graph the required scan must not silently pass.
  if ! tree_out="$(cargo tree -p termixion-core --edges normal --target all --all-features --prefix none 2>&1)"; then
    echo "check-core-seam: cargo tree could not resolve termixion-core's dependency graph — failing closed:" >&2
    printf '%s\n' "$tree_out" | sed 's/^/    /' >&2
    exit 1
  fi
  # `|| true`: with only `termixion-core` in the graph, `grep -v` emits nothing and exits 1 — the clean
  # (no-deps) case, not an error.
  dep_names="$(printf '%s\n' "$tree_out" \
    | sed -E 's/ v[0-9].*$//; s/ \(.*\)$//' \
    | grep -vxE 'termixion-core' | sort -u || true)"
  bad="$(printf '%s\n' "$dep_names" | grep -vE '^$' | grep -E "$forbidden_re" || true)"
  if [ -n "$bad" ]; then
    echo "check-core-seam: FORBIDDEN dependency in termixion-core (must stay platform-free, on all targets):" >&2
    printf '%s\n' "$bad" | sed 's/^/    /' >&2
    exit 1
  fi
else
  echo "check-core-seam: cargo not found — skipping the forbidden-dependency scan." >&2
fi

# (b) Source scan — tracked core source files (read from the working tree).
#
# This is a BEST-EFFORT textual lint enforcing the R2-documented selector set (it can't follow a
# `use std::os as alias` rename — only a Rust parser could). The HARD, semantic gates against platform
# code in core are gate (a) above (you can't reach a platform API without a platform crate or std::os,
# and crates are caught there) and core COMPILING ON THE LINUX CI JOB. This scan + review catch the
# common direct/accidental forms on top of those.
files="$(git ls-files -- 'crates/termixion-core/src' | grep -E '\.rs$' || true)"
[ -z "$files" ] && { echo "check-core-seam: no termixion-core source files."; exit 0; }

# Per file: strip /* block */ then // line/doc comments, flatten to one line (so multiline forms can't
# hide), then flag via a DIRECT token scan (no cfg-nesting games — selectors are matched wherever they
# appear, so cfg(all(any(...), unix)) and cfg_attr(..., windows) are all caught):
#   (1) any platform cfg SELECTOR — the R2 list (target_os/family/env/arch/vendor/pointer_width) are
#       cfg-only keywords, and a bare unix/windows in a platform-agnostic core is itself a red flag.
#       (target_feature/target_endian/target_has_atomic are intentionally NOT here — they gate portable
#       CPU-feature code, which R2 permits; forbidding them is a rule change, not a script change.)
#   (2) std::os in common import shapes — `std::os::*`, `std::os as x`, grouped `std::{ os::unix }`.
# `cfg(test)` is allowed (none of these tokens). A literal "unix"/"windows" string would also trip (1);
# the check fails closed, which in this small crate is acceptable.
plat_sel='target_os|target_family|target_env|target_arch|target_vendor|target_pointer_width|unix|windows'
os_re='\bstd::os\b|\bos::(unix|windows|wasi|fd|raw|solid)\b'

matched=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  flat="$(perl -0pe 's{/\*.*?\*/}{ }gs' "$f" | sed 's://.*$::' | tr '\n' ' ')"
  h1="$(printf '%s' "$flat" | grep -oE "\b($plat_sel)\b" | head -1 || true)"
  h2="$(printf '%s' "$flat" | grep -oE "$os_re" | head -1 || true)"
  if [ -n "$h1$h2" ]; then
    [ "$matched" -eq 0 ] && echo "check-core-seam: FORBIDDEN platform-specific code in termixion-core (keep it platform-agnostic):"
    echo "  $f:"
    [ -n "$h1" ] && echo "    platform cfg selector: $h1"
    [ -n "$h2" ] && echo "    platform std::os use: $h2"
    matched=1
  fi
done <<< "$files"

if [ "$matched" -eq 1 ]; then
  exit 1
fi
echo "check-core-seam: OK — no platform cfg / std::os in termixion-core."
