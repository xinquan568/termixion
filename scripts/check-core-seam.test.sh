#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for gate (c) of scripts/check-core-seam.sh (trmx-239, M12) — the SHELL-crate direct-dependency
# scan. R1 said only termixion-platform may declare platform crates while termixion-tauri declared `libc`
# and called geteuid; the fix moved that behind the seam, and this proves the gate that keeps it there.
#
# Three cases, and the third is the one a naive gate gets wrong:
#   (i)   the clean tree passes;
#   (ii)  an injected `libc` under [dependencies] FAILS   — the acceptance criterion, stated in the PR;
#   (iii) `libc` under [dev-dependencies] PASSES          — after the fix the shell legitimately keeps a
#         test-only libc (logging.rs's root check), so a gate on cargo tree's DEFAULT edge set (which
#         includes dev+build) would fail the very commit that fixes M12.
#
# The Cargo.toml mutation is restored on EVERY exit path, and the test refuses to run against an already
# -dirty Cargo.toml so it can never mask or destroy a real edit. Run: bash scripts/check-core-seam.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
GATE="$ROOT/scripts/check-core-seam.sh"
MANIFEST="crates/termixion-tauri/Cargo.toml"
[ -f "$GATE" ] || { echo "check-core-seam.test: gate not found at $GATE" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "check-core-seam.test: $MANIFEST not found" >&2; exit 1; }

# Refuse to touch a manifest that already has uncommitted changes: restoring would clobber them.
if ! git diff --quiet -- "$MANIFEST" || ! git diff --cached --quiet -- "$MANIFEST"; then
  echo "check-core-seam.test: $MANIFEST has uncommitted changes; refusing to mutate it." >&2
  exit 1
fi

BACKUP="$(mktemp)"
cp "$MANIFEST" "$BACKUP"
# Restore on ANY exit — success, failure, or interrupt. A crashed run must never leave `libc` re-added.
trap 'cp "$BACKUP" "$MANIFEST"; rm -f "$BACKUP"' EXIT INT TERM

fails=0
check() { # check <label> <expected: pass|fail>
  local label="$1" expect="$2" rc=0 out=""
  out="$(bash "$GATE" 2>&1)" || rc=$?
  if [ "$expect" = pass ] && [ "$rc" -ne 0 ]; then
    echo "FAIL: $label — expected the gate to PASS, got exit $rc:"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  elif [ "$expect" = fail ] && [ "$rc" -eq 0 ]; then
    echo "FAIL: $label — expected the gate to FAIL, but it passed."
    fails=$((fails + 1))
  else
    echo "ok: $label"
  fi
}

# Declare `libc` under exactly the named table of the tauri manifest.
inject() { # inject <table>
  local table="$1"
  python3 - "$MANIFEST" "$table" <<'PY'
import re, sys
path, table = sys.argv[1], sys.argv[2]
src = open(path).read()
# Drop every existing top-level `libc = ...` line, wherever it is declared, so the
# manifest stays valid TOML (the fixed tree already carries a dev-only one).
src = re.sub(r'(?m)^libc\s*=.*\n', '', src)
header = f"[{table}]"
if header in src:
    src = src.replace(header, header + '\nlibc = "0.2"', 1)
else:
    src = src.rstrip() + f"\n\n{header}\nlibc = \"0.2\"\n"
open(path, "w").write(src)
PY
}

# (i) the clean tree
check "clean tree passes" pass

# (ii) a direct runtime dependency is caught — THE acceptance criterion
cp "$BACKUP" "$MANIFEST"; inject dependencies
check "a direct [dependencies] libc in termixion-tauri is REFUSED" fail

# (iii) a dev-only dependency is not a shell violation
cp "$BACKUP" "$MANIFEST"; inject dev-dependencies
check "a [dev-dependencies] libc is ALLOWED (tests may use it)" pass

cp "$BACKUP" "$MANIFEST"
if [ "$fails" -ne 0 ]; then
  echo "check-core-seam.test: $fails case(s) failed." >&2
  exit 1
fi
echo "check-core-seam.test: OK (3 cases)."
