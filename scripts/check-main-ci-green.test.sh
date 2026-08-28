#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for scripts/check-main-ci-green.sh (trmx-242, grill H8).
#
# The dry run on a PR branch only ever exercises the no-matching-run branch. Everything that makes
# this gate CORRECT rather than merely present — the provenance filter, newest-run precedence,
# pagination, non-success conclusions, API failure, ancestry — is covered here.
#
# The `gh` stub serves RAW API JSON and applies the gate's OWN `--jq` program with real jq, so the
# provenance filter under test is the production one. A stub that emitted pre-filtered rows would
# leave `select(.path…)` / `select(.event…)` / `select(.head_branch…)` never executed, and the test
# would stay green if someone deleted them.
#
# Run: bash scripts/check-main-ci-green.test.sh
set -euo pipefail

GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-main-ci-green.sh"
[ -f "$GATE" ] || { echo "check-main-ci-green.test: gate not found at $GATE" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
mkdir -p "$tmp/bin"
fails=0

# Stub `gh`: finds the `--jq` program in its own argv and runs it against the fixture with real jq.
# With `--paginate`, gh applies the filter per page and concatenates — PAGES_DIR holds one JSON file
# per page, so multi-page selection is exercised rather than assumed.
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${GH_FAIL:-0}" = "1" ]; then echo "gh: API is down" >&2; exit 1; fi
prog=""; want=0
for a in "$@"; do
  if [ "$want" = 1 ]; then prog="$a"; want=0; continue; fi
  [ "$a" = "--jq" ] && want=1
done
for page in "$PAGES_DIR"/page-*.json; do
  [ -e "$page" ] || continue
  jq -r "$prog" < "$page"
done
STUB
chmod +x "$tmp/bin/gh"

pages() { # pages <json…>  — one argument per page
  rm -rf "$tmp/pages"; mkdir -p "$tmp/pages"
  local i=1
  for p in "$@"; do printf '%s' "$p" > "$tmp/pages/page-$i.json"; i=$((i + 1)); done
}

run_gate() { PATH="$tmp/bin:$PATH" SHA=deadbeef R=o/r SKIP_ANCESTRY=1 PAGES_DIR="$tmp/pages" \
             bash "$GATE" 2>&1; }

check() { # check <label> <pass|fail>
  local label="$1" expect="$2" rc=0 out=""
  out="$(run_gate)" || rc=$?
  if { [ "$expect" = pass ] && [ "$rc" -ne 0 ]; } || { [ "$expect" = fail ] && [ "$rc" -eq 0 ]; }; then
    echo "FAIL: $label — expected $expect, got exit $rc:"; printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok: $label"
  fi
}

# A run in the raw shape the API returns. Overridable so the provenance cases can vary one field.
run_json() { # run_json <created_at> <id> <status> <conclusion> [path] [event] [branch]
  jq -nc --arg c "$1" --argjson i "$2" --arg s "$3" --arg cc "$4" \
         --arg p "${5:-.github/workflows/ci.yml}" --arg e "${6:-push}" --arg b "${7:-main}" \
    '{created_at:$c, id:$i, status:$s, conclusion:(if $cc=="null" then null else $cc end),
      path:$p, event:$e, head_branch:$b}'
}
page() { jq -nc --argjson r "[$(printf '%s,' "$@" | sed 's/,$//')]" '{workflow_runs:$r}'; }
empty_page() { echo '{"workflow_runs":[]}'; }

pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 completed success)")"
check "a single green run passes" pass

pages "$(empty_page)"
check "no matching run FAILS CLOSED" fail

pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 completed failure)")"
check "a failed run FAILS" fail

pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 completed cancelled)")"
check "a cancelled run FAILS" fail

pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 completed skipped)")"
check "a skipped run FAILS" fail

pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 in_progress null)")"
check "an in-progress run with a NULL conclusion FAILS (not completed)" fail

# --- provenance: each of these is green, and must still be REJECTED because it is the wrong run ---
pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 completed success .github/workflows/release.yml)")"
check "a green run of a DIFFERENT workflow does not satisfy the gate" fail

pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 completed success .github/workflows/ci.yml pull_request)")"
check "a green PULL_REQUEST ci.yml run does not satisfy the gate" fail

pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 completed success .github/workflows/ci.yml push some-branch)")"
check "a green push run on ANOTHER BRANCH does not satisfy the gate" fail

# A qualifying run buried among non-qualifying ones must still be found.
pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 completed failure .github/workflows/ci.yml pull_request)" \
               "$(run_json 2026-08-28T09:01:00Z 1001 completed success)" \
               "$(run_json 2026-08-28T09:02:00Z 1002 completed failure .github/workflows/release.yml)")"
check "the qualifying run is found among non-qualifying ones" pass

# --- newest-run precedence -------------------------------------------------------------------
# THE case: same timestamp, ids 999 (green) and 1000 (failed). A lexicographic sort puts "999" last
# and would wrongly PASS. Numeric sorting on the id column picks 1000 — the newer run — and fails.
pages "$(page "$(run_json 2026-08-28T09:00:00Z 999 completed success)" \
               "$(run_json 2026-08-28T09:00:00Z 1000 completed failure)")"
check "a NEWER failure outranks an OLDER success at the same timestamp (numeric id sort)" fail

pages "$(page "$(run_json 2026-08-28T09:00:00Z 999 completed failure)" \
               "$(run_json 2026-08-28T09:00:00Z 1000 completed success)")"
check "a NEWER success outranks an OLDER failure" pass

pages "$(page "$(run_json 2026-08-28T08:00:00Z 1000 completed success)" \
               "$(run_json 2026-08-28T09:00:00Z 1001 completed failure)")"
check "the newest run by timestamp decides" fail

# --- pagination: the deciding run is on page 2 -------------------------------------------------
pages "$(page "$(run_json 2026-08-28T08:00:00Z 1000 completed success)")" \
      "$(page "$(run_json 2026-08-28T09:00:00Z 1001 completed failure)")"
check "a NEWER failure on a LATER PAGE is still seen (--paginate)" fail

pages "$(page "$(run_json 2026-08-28T08:00:00Z 1000 completed failure)")" \
      "$(page "$(run_json 2026-08-28T09:00:00Z 1001 completed success)")"
check "a NEWER success on a LATER PAGE decides (--paginate)" pass

# --- API failure -------------------------------------------------------------------------------
rc=0
out="$(PATH="$tmp/bin:$PATH" SHA=deadbeef R=o/r SKIP_ANCESTRY=1 PAGES_DIR="$tmp/pages" GH_FAIL=1 \
       bash "$GATE" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then
  echo "FAIL: an API error must FAIL CLOSED, got exit 0"; fails=$((fails + 1))
else
  echo "ok: an API error FAILS CLOSED"
fi

# --- ancestry: run the gate for real against a throwaway repo with a real `origin` ---------------
# SKIP_ANCESTRY is DELIBERATELY not set here, so `git fetch origin main` + `git merge-base
# --is-ancestor` execute. Without this the ancestry guard would be dead code as far as the suite is
# concerned, and "green push-to-main run" would be satisfiable by a commit that is not on main.
origin="$tmp/origin.git"; work="$tmp/work"
git init --quiet --bare "$origin"
git init --quiet -b main "$work"
git -C "$work" -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m base
git -C "$work" remote add origin "$origin"
git -C "$work" push --quiet origin main
on_main="$(git -C "$work" rev-parse HEAD)"
git -C "$work" checkout --quiet -b side
git -C "$work" -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m off-main
off_main="$(git -C "$work" rev-parse HEAD)"

ancestry() { # ancestry <sha>
  ( cd "$work" && PATH="$tmp/bin:$PATH" SHA="$1" R=o/r PAGES_DIR="$tmp/pages" bash "$GATE" 2>&1 )
}
pages "$(page "$(run_json 2026-08-28T09:00:00Z 1000 completed success)")"

rc=0; out="$(ancestry "$on_main")" || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "FAIL: a green run on a commit that IS on main should pass ancestry:"; printf '%s\n' "$out" | sed 's/^/    /'
  fails=$((fails + 1))
else
  echo "ok: a commit on main passes the ancestry check"
fi

rc=0; out="$(ancestry "$off_main")" || rc=$?
if [ "$rc" -eq 0 ]; then
  echo "FAIL: a green run on an OFF-MAIN commit must be REJECTED, got exit 0"; fails=$((fails + 1))
elif ! printf '%s' "$out" | grep -q 'not an ancestor of origin/main'; then
  echo "FAIL: off-main commit failed, but not on the ancestry check:"; printf '%s\n' "$out" | sed 's/^/    /'
  fails=$((fails + 1))
else
  echo "ok: an off-main commit is REJECTED by the ancestry check"
fi

if [ "$fails" -ne 0 ]; then
  echo "check-main-ci-green.test: $fails case(s) failed." >&2
  exit 1
fi
echo "check-main-ci-green.test: OK (18 cases)."
