#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion churn/leak catcher (trmx-103, Beta hardening §3). Opens + closes N tabs and N splits in a
# loop against a LIVE packaged app, driving the churn over the trmx-101 remote-control socket (`ctl`) and
# checking the app's DESCENDANT TREE for the classic PTY-leak signatures each round: zombie children
# (walked by PPID, not process group — PTY shells run in their own groups), a growing fd count (`lsof`),
# and a growing thread count. Pass = a real churn actually happened (the socket works + ops succeeded),
# zero zombies at every checkpoint, and a stable fd/thread envelope.
#
# TWO DISTINCT INPUTS (not the same thing):
#   --pid <app-pid>   the running app process, for the process metrics (lsof / ps descendant walk). REQUIRED.
#   --socket <path>   the ctl control socket, for driving the churn. Optional (ctl's default is used).
# The control socket is OPT-IN (remote_control.enabled) and is force-disabled under --smoke/--perf, so the
# operator must launch a NORMAL app with remote control enabled in config before running this.
#
# Usage: scripts/churn.sh [--pid PID] [--socket PATH] [--count N] [--ctl PATH-TO-ctl-binary]
#   default count 200; app pid discovered via `pgrep -f Termixion` if --pid omitted (REFUSES on ambiguity).
set -euo pipefail

COUNT=200
APP_PID=""
SOCKET=""
CTL="termixion"   # `<CTL> ctl <cmd>` (the app binary forks to run_ctl on argv[1]=="ctl")
while [ $# -gt 0 ]; do
  case "$1" in
    --pid) APP_PID="$2"; shift 2 ;;
    --socket) SOCKET="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    --ctl) CTL="$2"; shift 2 ;;
    *) echo "churn: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$APP_PID" ]; then
  matches="$(pgrep -f 'Termixion' || true)"
  n="$(printf '%s\n' "$matches" | grep -c . || true)"
  if [ "$n" != "1" ]; then
    echo "churn: could not uniquely discover the app pid (found ${n:-0}); pass --pid <app-pid>." >&2
    exit 2
  fi
  APP_PID="$matches"
fi
echo "churn: app pid=$APP_PID, count=$COUNT, ctl=$CTL${SOCKET:+ socket=$SOCKET}"

ctl() { if [ -n "$SOCKET" ]; then "$CTL" ctl --socket "$SOCKET" "$@"; else "$CTL" ctl "$@"; fi; }

# PREFLIGHT: prove the control socket actually works before trusting any churn (finding: a masked-failure
# loop would otherwise reach DONE on a dead socket and falsely bless a no-churn run).
if ! ctl version >/dev/null 2>&1; then
  echo "churn: FAIL — 'ctl version' did not answer. Launch a normal app with remote_control.enabled=true" >&2
  echo "churn:        (the socket is force-disabled under --smoke/--perf), and pass the right --socket." >&2
  exit 1
fi

# Descendant walk by PPID (PTY shells + their fg jobs live in their OWN process groups, so `ps -g` misses
# them). Collect the whole subtree rooted at the app pid.
descendants() {
  local root="$1" frontier next pid
  frontier="$root"
  local all=""
  while [ -n "$frontier" ]; do
    next=""
    for pid in $frontier; do
      all="$all $pid"
      # children of pid
      local kids; kids="$(ps -o pid= -o ppid= -ax 2>/dev/null | awk -v p="$pid" '$2==p {print $1}')"
      next="$next $kids"
    done
    frontier="$next"
  done
  echo "$all"
}
assert_no_zombies() {
  local label="$1" z="" pid stat
  for pid in $(descendants "$APP_PID"); do
    stat="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    case "$stat" in Z*) z="$z $pid";; esac
  done
  if [ -n "$z" ]; then echo "churn: FAIL ($label) — zombie descendant pid(s):$z" >&2; exit 1; fi
}
fd_count()     { lsof -p "$APP_PID" 2>/dev/null | wc -l | tr -d ' '; }
thread_count() { ps -M "$APP_PID" 2>/dev/null | tail -n +2 | wc -l | tr -d ' '; }

# A churn op that MUST succeed (tab.new / split): a failure means the socket regressed → fail the run.
ok=0
must() { if ctl "$1" >/dev/null 2>&1; then ok=$((ok + 1)); else echo "churn: FAIL — ctl $1 failed mid-run (op #$ok)" >&2; exit 1; fi; }
# A churn op that MAY legitimately fail (closing when nothing is there): tolerated, not counted as churn.
may() { ctl "$1" >/dev/null 2>&1 || true; }

fd0="$(fd_count)"; th0="$(thread_count)"
assert_no_zombies "baseline"
echo "churn: baseline fds=$fd0 threads=$th0"

for i in $(seq 1 "$COUNT"); do
  must tab.new
  must pane.split-right
  must pane.split-below
  may  pane.close
  may  pane.close
  may  tab.close
  if [ $((i % 20)) -eq 0 ]; then
    assert_no_zombies "round $i"
    echo "churn: round $i — fds=$(fd_count) threads=$(thread_count) (ok ops so far: $ok)"
  fi
done

sleep 2   # let the last teardowns settle before the final envelope read
assert_no_zombies "final"
fd1="$(fd_count)"; th1="$(thread_count)"
if [ "$ok" -eq 0 ]; then echo "churn: FAIL — zero successful churn ops; nothing was exercised." >&2; exit 1; fi
echo "churn: $ok successful churn ops; final fds=$fd1 (baseline $fd0), threads=$th1 (baseline $th0)"
echo "churn: DONE — record the fd/thread deltas in docs/design/beta-hardening-report.md. A stable envelope"
echo "churn:        (no monotonic growth across rounds) + zero zombies is the PTY-leak pass."
