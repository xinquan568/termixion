#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion soak leak-check (trmx-103, Beta hardening §3). Captures the memory / fd / thread footprint of a
# LIVE app process at a single instant, so the operator runs it BEFORE and AFTER a 24 h soak (roadmap §10:
# 3 tabs, one 2x2 split, one pane looping `while :; do seq 1 10000; sleep 5; done`, one idle, one in vim)
# and diffs the two snapshots. Pass = no unbounded growth (memory bounded by the scrollback caps, fd + thread
# counts flat). This script only READS process state — it never touches the app.
#
# Usage: scripts/leak-check.sh [--pid PID] [--label before|after]
#   The app pid is discovered via `pgrep -f Termixion` if --pid is omitted (REFUSES on ambiguity).
set -euo pipefail

APP_PID=""
LABEL="snapshot"
while [ $# -gt 0 ]; do
  case "$1" in
    --pid) APP_PID="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    *) echo "leak-check: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$APP_PID" ]; then
  matches="$(pgrep -f 'Termixion' || true)"
  n="$(printf '%s\n' "$matches" | grep -c . || true)"
  if [ "$n" != "1" ]; then
    echo "leak-check: could not uniquely discover the app pid (found ${n:-0}); pass --pid <app-pid>." >&2
    exit 2
  fi
  APP_PID="$matches"
fi

# RSS (KB → MB) + fd count + thread count for the app pid.
rss_kb="$(ps -o rss= -p "$APP_PID" | tr -d ' ')"
rss_mb=$(( rss_kb / 1024 ))
fds="$(lsof -p "$APP_PID" 2>/dev/null | wc -l | tr -d ' ')"
threads="$(ps -M "$APP_PID" 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')"
# Descendant zombie sweep (a leaked PTY child is a Z-state descendant).
pgid="$(ps -o pgid= -p "$APP_PID" | tr -d ' ')"
zombies="$(ps -o pid=,stat= -g "$pgid" 2>/dev/null | awk '$2 ~ /^Z/' | wc -l | tr -d ' ')"

echo "leak-check [$LABEL]: pid=$APP_PID rss=${rss_mb}MB fds=$fds threads=$threads zombies=$zombies"
# `footprint` is the higher-fidelity macOS memory tool (dirty + swapped) — advisory, not all hosts have it.
if command -v footprint >/dev/null 2>&1; then
  echo "leak-check [$LABEL]: footprint summary —"
  footprint -p "$APP_PID" 2>/dev/null | grep -iE 'dirty|footprint|physical' | head -5 || true
fi
if [ "$zombies" != "0" ]; then
  echo "leak-check [$LABEL]: WARNING — $zombies zombie descendant(s); investigate before the GO." >&2
fi
echo "leak-check [$LABEL]: record this line in the report's soak table; diff before-vs-after for unbounded growth."
