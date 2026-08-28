#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for gate (c) of scripts/check-core-seam.sh (trmx-239, M12) — the SHELL-crate direct
# -dependency scan. R1 said only termixion-platform may declare platform crates while termixion-tauri
# declared `libc` and called geteuid; the fix moved that behind the seam, and this proves the gate
# that keeps it there.
#
# THE MUTATION NEVER TOUCHES YOUR TREE. An earlier design edited the real crates/termixion-tauri/
# Cargo.toml and restored it from a backup with a trap. That is unsafe however careful the trap is:
# the dirty-check has a TOCTOU window against an editor saving after the backup, the restoring `cp`
# is not atomic, and SIGKILL bypasses traps entirely — a crashed test could leave the manifest
# modified or truncated. Instead each case runs in a THROWAWAY `git worktree` of HEAD, so the worst
# case is a leftover temp directory.
#
# Cases (the third is the one a naive gate gets wrong, and the fourth is the loophole a resolved
# -graph scan leaves open):
#   (i)   the clean tree passes;
#   (ii)  `libc` under [dependencies]                 → FAILS  (the acceptance criterion)
#   (iii) `libc` under [dev-dependencies]             → passes (logging.rs's root check is test-only)
#   (iv)  an OPTIONAL `libc` behind a disabled feature → FAILS  (it is still a declaration)
#
# Run: bash scripts/check-core-seam.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
command -v git >/dev/null 2>&1 || { echo "check-core-seam.test: git not found" >&2; exit 1; }

tmp="$(mktemp -d)"
cleanup() {
  # Remove the worktree registration first so `git worktree list` stays clean, then the files.
  [ -d "$tmp/wt" ] && git -C "$ROOT" worktree remove --force "$tmp/wt" >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
fails=0

# A pristine checkout of HEAD. Nothing here is tracked by the developer's working tree, so the
# mutations below are unobservable outside $tmp.
git -C "$ROOT" worktree add --detach --quiet "$tmp/wt" HEAD

MANIFEST="$tmp/wt/crates/termixion-tauri/Cargo.toml"
PRISTINE="$tmp/pristine.toml"
cp "$MANIFEST" "$PRISTINE"

# Declare `libc` under exactly the named table, removing any existing declaration first so the
# manifest stays valid TOML (the fixed tree already carries a dev-only one).
declare_libc() { # declare_libc <table> [extra-keys]
  python3 - "$MANIFEST" "$1" "${2-}" <<'PY'
import re, sys
path, table, extra = sys.argv[1], sys.argv[2], sys.argv[3]
src = re.sub(r'(?m)^libc\s*=.*\n', '', open(path).read())
line = 'libc = { version = "0.2"' + (', ' + extra if extra else '') + ' }'
header = f"[{table}]"
if header in src:
    src = src.replace(header, header + "\n" + line, 1)
else:
    src = src.rstrip() + f"\n\n{header}\n{line}\n"
open(path, "w").write(src)
PY
}

check() { # check <label> <expected: pass|fail>
  local label="$1" expect="$2" rc=0 out=""
  # The gate under test is the WORKING-TREE one ("$ROOT/scripts/…"), run with the mutated worktree as
  # CWD. Running the worktree's own copy would test the last COMMITTED gate instead — silently one
  # commit stale during development, which cost a confusing red run when this test was written.
  out="$(cd "$tmp/wt" && bash "$ROOT/scripts/check-core-seam.sh" 2>&1)" || rc=$?
  if [ "$expect" = pass ] && [ "$rc" -ne 0 ]; then
    echo "FAIL: $label — expected PASS, got exit $rc:"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  elif [ "$expect" = fail ] && [ "$rc" -eq 0 ]; then
    echo "FAIL: $label — expected FAIL, but the gate passed."
    fails=$((fails + 1))
  else
    echo "ok: $label"
  fi
}

check "clean tree passes" pass

cp "$PRISTINE" "$MANIFEST"; declare_libc dependencies
check "a direct [dependencies] libc in termixion-tauri is REFUSED" fail

cp "$PRISTINE" "$MANIFEST"; declare_libc dev-dependencies
check "a [dev-dependencies] libc is ALLOWED (tests may use it)" pass

# An optional dependency behind a feature nobody enables is INVISIBLE to `cargo tree`, which reports
# the resolved graph. The gate reads declarations, so it still catches this.
cp "$PRISTINE" "$MANIFEST"; declare_libc dependencies 'optional = true'
check "an OPTIONAL [dependencies] libc is REFUSED (declaration, not resolution)" fail

if [ "$fails" -ne 0 ]; then
  echo "check-core-seam.test: $fails case(s) failed." >&2
  exit 1
fi
echo "check-core-seam.test: OK (4 cases; the developer's tree was never modified)."
