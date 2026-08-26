#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for scripts/check-control-protocol.sh (trmx-235): a throwaway git repo with the fixture and the two
# protocol constants; branches remove/add ids with and without a protocol bump. Run: bash scripts/check-control-protocol.test.sh
set -euo pipefail
GATE="${CONTROL_GATE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-control-protocol.sh}"
[ -f "$GATE" ] || { echo "check-control-protocol.test: gate not found at $GATE"; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1 (exit $3)"; else echo "  FAIL $1: expected exit $2, got $3"; fails=$((fails + 1)); fi; }
run() { set +e; (cd "$tmp" && bash "$GATE" --range "$1" >/dev/null 2>&1); rc=$?; set -e; echo "$rc"; }
write_tree() { # write_tree <protocol> <ids-json-array>
  mkdir -p "$tmp/app/src/control/__fixtures__" "$tmp/crates/termixion-tauri/src"
  printf '{ "protocol": %s, "commands": %s }\n' "$1" "$2" > "$tmp/app/src/control/__fixtures__/control-commands.json"
  printf 'export const CONTROL_PROTOCOL_VERSION = %s;\n' "$1" > "$tmp/app/src/control/controlBridge.ts"
  printf 'pub const PROTOCOL_VERSION: u32 = %s;\n' "$1" > "$tmp/crates/termixion-tauri/src/control_io.rs"
}
git -C "$tmp" init -q -b main; git -C "$tmp" config user.email t@example.com; git -C "$tmp" config user.name t; git -C "$tmp" config commit.gpgsign false
write_tree 1 '["pane.close", "tab.new"]'; git -C "$tmp" add -A; git -C "$tmp" commit -q -m base
branch() { git -C "$tmp" checkout -q main; git -C "$tmp" checkout -q -b "$1"; }
branch remove-no-bump;      write_tree 1 '["tab.new"]';                       git -C "$tmp" commit -qam x
branch remove-bump;         write_tree 2 '["tab.new"]';                       git -C "$tmp" commit -qam x
branch remove-fixture-only; write_tree 2 '["tab.new"]'; printf 'export const CONTROL_PROTOCOL_VERSION = 1;\n' > "$tmp/app/src/control/controlBridge.ts"; git -C "$tmp" commit -qam x
branch add-no-bump;         write_tree 1 '["pane.close", "tab.new", "tab.rename"]'; git -C "$tmp" commit -qam x
branch add-bump;            write_tree 2 '["pane.close", "tab.new", "tab.rename"]'; git -C "$tmp" commit -qam x
branch unchanged;           echo doc > "$tmp/README"; git -C "$tmp" add README; git -C "$tmp" commit -qm x
echo "check-control-protocol.test:"
check "removal without bump is refused"            1 "$(run main...remove-no-bump)"
check "removal with a bump on all three sides passes" 0 "$(run main...remove-bump)"
check "bump in the fixture only (constant stale) is refused" 1 "$(run main...remove-fixture-only)"
check "addition without a bump is refused"         1 "$(run main...add-no-bump)"
check "addition with a bump passes"                0 "$(run main...add-bump)"
check "unchanged fixture passes"                   0 "$(run main...unchanged)"
check "two-dot range works"                        1 "$(run main..remove-no-bump)"
check "unresolvable range fails loudly"            2 "$(run main...no-such-ref)"
set +e; (cd "$tmp" && bash "$GATE" --range --quiet >/dev/null 2>&1); rc=$?; set -e; check "malformed operand exits 2" 2 "$rc"
[ "$fails" -eq 0 ] && { echo "check-control-protocol.test: all passed"; exit 0; }
echo "check-control-protocol.test: $fails failure(s)"; exit 1
