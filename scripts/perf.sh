#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion NFR-1 performance runner (trmx-78). Runs the PACKAGED app's `--perf` mode — the
# in-binary harness that mounts the real xterm/WebGL pipeline, drives the typing-latency and
# scroll-throughput scenarios over the production PTY channel, writes a JSON report, and exits
# 0/1 on budget pass/fail (docs/design/performance-protocol.md).
#
# Usage: scripts/perf.sh [--commit] [path-to-Termixion-binary] [out-dir]
#   binary default: target/release/bundle/macos/Termixion.app (the RECORDED numbers must come
#   from release; the debug bundle is accepted for iteration with a loud warning)
#     build it with:  (cd crates/termixion-tauri && cargo tauri build)
#   out-dir default: a fresh mktemp -d
#   --commit: merge machine identity into the report and copy it to
#     docs/design/perf-results/<date>-v<version>.json — REFUSED unless the report says
#     "build": "release" AND "pass": true (debug numbers and invalid/occluded runs are never
#     the record; a rAF-throttled run behind a sleeping display fails exactly this way).
# Exit code: the app's own budget verdict (0 pass / 1 fail); --commit failures also exit 1.
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

COMMIT=0
if [[ "${1:-}" == "--commit" ]]; then
  COMMIT=1
  shift
fi

APP="${1:-target/release/bundle/macos/Termixion.app}"
if [[ ! -e "$APP" && "$APP" == target/release/* ]]; then
  DEBUG_APP="target/debug/bundle/macos/Termixion.app"
  if [[ -e "$DEBUG_APP" ]]; then
    echo "perf: WARNING — release bundle not found; falling back to the DEBUG bundle." >&2
    echo "perf: debug numbers are NOT the record and --commit will refuse them." >&2
    APP="$DEBUG_APP"
  fi
fi
if [[ ! -e "$APP" ]]; then
  echo "perf: app not found at '$APP' — build it first:" >&2
  echo "  (cd crates/termixion-tauri && cargo tauri build)" >&2
  exit 1
fi

OUT="${2:-$(mktemp -d /tmp/termixion-perf.XXXXXX)}"
mkdir -p "$OUT"

# Resolve the actual executable inside a .app bundle (smoke.sh's convention).
BIN="$APP"
if [[ -d "$APP" && "$APP" == *.app ]]; then
  BIN="$APP/Contents/MacOS/$(defaults read "$(cd "$APP" && pwd)/Contents/Info" CFBundleExecutable 2>/dev/null || echo Termixion)"
fi

echo "perf: running $BIN"
echo "perf: report dir $OUT"
echo "perf: keep the Termixion window frontmost and the display awake for the whole run (~2 min)."

STATUS=0
TERMIXION_PERF_OUT="$OUT" "$BIN" --perf || STATUS=$?

REPORT="$OUT/report.json"
if [[ ! -s "$REPORT" ]]; then
  echo "perf: FAIL — no report at $REPORT (watchdog timeout or launch failure)" >&2
  exit 1
fi

echo "perf: verdict (exit $STATUS):"
python3 - "$REPORT" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
t = r.get("scenarios", {}).get("typing") or {}
print(f"  renderer={r.get('renderer')} build={r.get('build')} pass={r.get('pass')} — {r.get('reason','')}")
if t:
    print(f"  typing: p50={t['p50']:.1f}ms p95={t['p95']:.1f}ms p99={t['p99']:.1f}ms max={t['max']:.1f}ms (n={t['count']})")
for name in ("scrollSeq", "scrollYes", "scrollbackPaging"):
    s = r.get("scenarios", {}).get(name)
    if s:
        print(f"  {name}: dropped {s['droppedPct']:.2f}% ({s['missed']}/{s['totalFrames']} frames)")
EOF

if [[ "$COMMIT" == 1 ]]; then
  VERSION="$(python3 -c "import json;print(json.load(open('app/package.json'))['version'])" 2>/dev/null || echo unknown)"
  DEST="docs/design/perf-results/$(date +%Y-%m-%d)-v${VERSION}.json"
  mkdir -p docs/design/perf-results
  python3 - "$REPORT" "$DEST" <<'EOF'
import json, subprocess, sys
report = json.load(open(sys.argv[1]))
if report.get("build") != "release":
    print("perf: --commit REFUSED — report build is not 'release'; debug numbers are never the record.", file=sys.stderr)
    sys.exit(1)
if not report.get("pass"):
    print("perf: --commit REFUSED — report did not pass (invalid conditions or missed budgets);", file=sys.stderr)
    print(f"perf: reason: {report.get('reason','')} (hasFocus={report.get('hasFocus')})", file=sys.stderr)
    sys.exit(1)
def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"
report["machine"] = {
    "model": sh("sysctl", "-n", "hw.model"),
    "chip": sh("sysctl", "-n", "machdep.cpu.brand_string"),
    "macos": sh("sw_vers", "-productVersion"),
    "memoryBytes": int(sh("sysctl", "-n", "hw.memsize") or 0),
}
json.dump(report, open(sys.argv[2], "w"), indent=2)
print(f"perf: committed results to {sys.argv[2]}")
EOF
fi

exit "$STATUS"
