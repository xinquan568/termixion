#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# trmx-235: the control-protocol compatibility gate. The externally callable command set is pinned by
# app/src/control/__fixtures__/control-commands.json. Removing or renaming an id is a BREAKING change to
# the remote-control protocol (docs/remote-control.md) — and the SET ITSELF is part of the protocol — so
# between <a> and <b> this refuses ANY change to the `commands` set (add, remove, rename) unless `protocol`
# increases AND both source constants (CONTROL_PROTOCOL_VERSION in controlBridge.ts, PROTOCOL_VERSION in
# control_io.rs) equal the new value. Exit: 0 ok · 1 violation · 2 usage / unresolvable range (never vacuous).
set -euo pipefail

FIXTURE="app/src/control/__fixtures__/control-commands.json"
TS="app/src/control/controlBridge.ts"
RS="crates/termixion-tauri/src/control_io.rs"

usage() { echo "check-control-protocol: usage: check-control-protocol.sh --range <a>..<b> | --range <a>...<b>"; }
[ "$#" -eq 2 ] && [ "$1" = "--range" ] || { usage; exit 2; }
range="$2"
case "$range" in -*) echo "check-control-protocol: malformed range '$range'"; usage; exit 2;; esac
left="${range%%..*}"; right="${range##*..}"
if [ "$left" = "$range" ] || [ -z "$left" ] || [ -z "$right" ] || [ "${right#.}" != "$right" ]; then
  echo "check-control-protocol: malformed range '$range' (expected <a>..<b> or <a>...<b>)"; usage; exit 2
fi
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$ROOT"
if ! git rev-parse --verify --quiet "$right^{commit}" >/dev/null || ! git rev-parse --verify --quiet "$left^{commit}" >/dev/null; then
  echo "check-control-protocol: cannot resolve range '$range' (fetch the base ref, e.g. checkout with fetch-depth: 0)"; exit 2
fi
case "$range" in
  *...*) base="$(git merge-base "$left" "$right")" || { echo "check-control-protocol: no merge base for '$range'"; exit 2; } ;;
  *)     base="$left" ;;
esac
head="$right"

show() { git show "$1:$2" 2>/dev/null || true; }   # empty when the path does not exist at that commit
base_fixture="$(show "$base" "$FIXTURE")"
head_fixture="$(show "$head" "$FIXTURE")"
if [ -z "$head_fixture" ]; then
  if [ -z "$base_fixture" ]; then echo "check-control-protocol: no fixture at either end — nothing to check."; exit 0; fi
  echo "check-control-protocol: $FIXTURE was REMOVED — the protocol pin must not disappear."; exit 1
fi
if [ -z "$base_fixture" ]; then echo "check-control-protocol: fixture introduced in this range — OK."; exit 0; fi

head_ts="$(show "$head" "$TS")"; head_rs="$(show "$head" "$RS")"
ts_const="$(printf '%s\n' "$head_ts" | sed -nE 's/^export const CONTROL_PROTOCOL_VERSION = ([0-9]+);.*/\1/p' | head -1)"
rs_const="$(printf '%s\n' "$head_rs" | sed -nE 's/^pub const PROTOCOL_VERSION: u32 = ([0-9]+);.*/\1/p' | head -1)"

verdict="$(BASE_FIXTURE="$base_fixture" HEAD_FIXTURE="$head_fixture" TS_CONST="${ts_const:-?}" RS_CONST="${rs_const:-?}" python3 - <<'PY'
import json, os, sys
b = json.loads(os.environ["BASE_FIXTURE"]); h = json.loads(os.environ["HEAD_FIXTURE"])
bp, hp = int(b["protocol"]), int(h["protocol"])
removed = sorted(set(b["commands"]) - set(h["commands"]))
added = sorted(set(h["commands"]) - set(b["commands"]))
ts, rs = os.environ["TS_CONST"], os.environ["RS_CONST"]
problems = []
changed = removed or added
if changed and hp <= bp:
    what = "; ".join(x for x in [f"removed: {', '.join(removed)}" if removed else "", f"added: {', '.join(added)}" if added else ""] if x)
    problems.append(f"callable set changed ({what}) but protocol stayed {bp} -> bump `protocol` in the fixture")
if hp != bp or changed:
    if ts != str(hp): problems.append(f"controlBridge.ts CONTROL_PROTOCOL_VERSION = {ts}, fixture protocol = {hp}")
    if rs != str(hp): problems.append(f"control_io.rs PROTOCOL_VERSION = {rs}, fixture protocol = {hp}")
print(f"removed={len(removed)} added={len(added)} protocol {bp}->{hp} ts={ts} rs={rs}")
for p in problems: print("VIOLATION: " + p)
sys.exit(1 if problems else 0)
PY
)" && rc=0 || rc=$?
printf '%s\n' "$verdict"
if [ "$rc" -eq 0 ]; then echo "check-control-protocol: OK."; exit 0; fi
echo "check-control-protocol: the callable command set changed without a matching protocol bump (see docs/remote-control.md)."; exit 1
