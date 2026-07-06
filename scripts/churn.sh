#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion churn/leak catcher (trmx-103, Beta hardening §3). Opens + closes N tabs and N splits in a
# loop against a LIVE packaged app, driving the churn over the trmx-101 remote-control socket (`ctl`) and
# checking the app process for the classic PTY-leak signatures each round: zombie children (`ps -o stat=`),
# a growing fd count (`lsof`), and a growing thread count. Pass = zero zombies at every checkpoint + a
# stable fd/thread envelope across the loop.
#
# TWO DISTINCT INPUTS (they are not the same thing):
#   --pid <app-pid>   the running app process, for the process metrics (lsof / ps). REQUIRED (or discovered).
#   --socket <path>   the ctl control socket, for driving the churn. Optional (ctl's default is used).
# The control socket is OPT-IN (remote_control.enabled) and is force-disabled under --smoke/--perf, so the
# operator must launch a NORMAL app with remote control enabled in config before running this.
#
# Usage: scripts/churn.sh [--pid PID] [--socket PATH] [--count N] [--ctl PATH-TO-ctl-binary]
#   default count 200; the app pid is discovered via `pgrep -f Termixion` if --pid is omitted (REFUSES on
#   ambiguity — >1 match → pass --pid explicitly).
set -euo pipefail

COUNT=200
APP_PID=""
SOCKET=""
CTL="termixion"   # the ctl entrypoint: `<CTL> ctl <cmd>` (the app binary forks to run_ctl on argv[1]=="ctl")
while [ $# -gt 0 ]; do
  case "$1" in
    --pid) APP_PID="$2"; shift 2 ;;
    --socket) SOCKET="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    --ctl) CTL="$2"; shift 2 ;;
    *) echo "churn: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve the app pid (for metrics) — refuse on ambiguity so we never measure the wrong process.
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

# Metric probes against the APP pid (not the socket).
fd_count()     { lsof -p "$APP_PID" 2>/dev/null | wc -l | tr -d ' '; }
thread_count() { ps -M "$APP_PID" 2>/dev/null | tail -n +2 | wc -l | tr -d ' '; }
# Zombie sweep: the app pid AND every descendant (a leaked PTY child shows as a Z-state descendant).
assert_no_zombies() {
  local label="$1" z
  z="$(ps -o pid=,stat=,command= -g "$(ps -o pgid= -p "$APP_PID" | tr -d ' ')" 2>/dev/null \
        | awk '$2 ~ /^Z/ { print }' || true)"
  if [ -n "$z" ]; then echo "churn: FAIL ($label) — zombie process(es) found:" >&2; echo "$z" >&2; exit 1; fi
}

fd0="$(fd_count)"; th0="$(thread_count)"
assert_no_zombies "baseline"
echo "churn: baseline fds=$fd0 threads=$th0"

for i in $(seq 1 "$COUNT"); do
  ctl tab.new            >/dev/null 2>&1 || true
  ctl pane.split-right   >/dev/null 2>&1 || true
  ctl pane.split-below   >/dev/null 2>&1 || true
  ctl pane.close         >/dev/null 2>&1 || true
  ctl pane.close         >/dev/null 2>&1 || true
  ctl tab.close          >/dev/null 2>&1 || true
  if [ $((i % 20)) -eq 0 ]; then
    assert_no_zombies "round $i"
    echo "churn: round $i — fds=$(fd_count) threads=$(thread_count)"
  fi
done

sleep 2   # let the last teardowns settle before the final envelope read
assert_no_zombies "final"
fd1="$(fd_count)"; th1="$(thread_count)"
echo "churn: final fds=$fd1 (baseline $fd0), threads=$th1 (baseline $th0)"
echo "churn: DONE — record the fd/thread deltas in docs/design/beta-hardening-report.md. A stable envelope"
echo "churn:        (no monotonic growth across rounds) + zero zombies is the PTY-leak pass."
