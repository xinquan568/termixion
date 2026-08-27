#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for scripts/check-issue-link.sh (trmx-261). The gate reads PR metadata from the environment, so the
# test drives it purely through env — no git repo needed — with a stub `gh` on PATH standing in for the
# issue-existence lookup (#1 exists as an issue, #2 is a pull request, anything else 404s). Covers the
# dependabot[bot] allowance (both halves required) plus every pre-existing failure mode, so a later change to
# the exemption cannot quietly widen it. Run: bash scripts/check-issue-link.test.sh
set -euo pipefail

GATE="${ISSUE_LINK_GATE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-issue-link.sh}"
[ -f "$GATE" ] || { echo "check-issue-link.test: gate not found at $GATE"; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
rc=0
out=""

# Stub `gh`: the gate only ever calls `gh api repos/<owner>/<name>/issues/<N> --jq …`.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'STUB'
#!/usr/bin/env bash
n="${2##*/}"
case "$n" in
  1) echo issue ;;
  2) echo pr ;;
  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmp/bin/gh"

# run <head-ref> <title> <body> [author] — sets $rc and $out. A 4th argument absent means PR_AUTHOR unset.
run() {
  local -a e=(PATH="$tmp/bin:$PATH" REPO="acme/termixion" GH_TOKEN=stub
              HEAD_REF="$1" PR_TITLE="$2" PR_BODY="$3")
  if [ "$#" -ge 4 ]; then e+=(PR_AUTHOR="$4"); fi
  set +e
  out="$(env "${e[@]}" bash "$GATE" 2>&1)"
  rc=$?
  set -e
}
check() { # check <name> <expected-exit>
  if [ "$2" = "$rc" ]; then echo "  ok   $1 (exit $rc)"; else echo "  FAIL $1: expected exit $2, got $rc"; fails=$((fails + 1)); fi
}
expect_out() { # expect_out <name> <substring> — asserts on the last run's combined output
  if grep -qF -- "$2" <<<"$out"; then echo "  ok   $1"; else echo "  FAIL $1: output lacks '$2'"; fails=$((fails + 1)); fi
}

DB_TITLE="chore(deps): bump serde from 1.0.1 to 1.0.2"
echo "check-issue-link.test:"

# --- the human path is unchanged ------------------------------------------------------------------
run "xinquan568/ai/trmx-1-slug" "feat(x): thing (trmx-1)" "Closes #1" "xinquan568"
check "consistent branch / title / body on a real issue passes" 0
run "xinquan568/ai/trmx-1-slug" "feat(x): thing (trmx-1)" "Follows #99. Closes #1" "xinquan568"
check "body may carry unrelated #refs alongside the right one" 0
run "xinquan568/ai/no-number" "feat(x): thing (trmx-1)" "Closes #1" "xinquan568"
check "branch without trmx-N is refused" 1
run "xinquan568/ai/trmx-1-slug" "feat(x): thing" "Closes #1" "xinquan568"
check "title not ending in (trmx-N) is refused" 1
run "xinquan568/ai/trmx-1-slug" "feat(x): thing (trmx-3)" "Closes #1" "xinquan568"
check "branch/title mismatch is refused" 1
run "xinquan568/ai/trmx-1-slug" "feat(x): thing (trmx-1)" "no link here" "xinquan568"
check "body missing #N is refused" 1
run "xinquan568/ai/trmx-1-slug" "feat(x): thing (trmx-1)" "Closes #99" "xinquan568"
check "body linking a different #N is refused" 1
run "xinquan568/ai/trmx-2-slug" "feat(x): thing (trmx-2)" "Closes #2" "xinquan568"
check "trmx-N pointing at a pull request is refused" 1
run "xinquan568/ai/trmx-7-slug" "feat(x): thing (trmx-7)" "Closes #7" "xinquan568"
check "trmx-N pointing at a missing issue is refused" 1

# --- the dependabot[bot] allowance (trmx-261) -----------------------------------------------------
run "dependabot/cargo/serde-1.0.2" "$DB_TITLE" "Bumps serde." "dependabot[bot]"
check "dependabot[bot] on a dependabot branch is exempt" 0
expect_out "the exemption is announced, never a silent pass" "exempt"
run "dependabot/github_actions/actions-a1b2c3" "chore(deps): bump the actions group" "" "dependabot[bot]"
check "dependabot[bot] on a grouped-update branch is exempt" 0
run "dependabot-cargo-serde-1.0.2" "$DB_TITLE" "Bumps serde." "dependabot[bot]"
check "dependabot[bot] on a custom-separator branch is exempt" 0

# --- the allowance must not widen -----------------------------------------------------------------
run "dependabot/cargo/serde-1.0.2" "$DB_TITLE" "Bumps serde." "xinquan568"
check "a human on a dependabot-shaped branch is NOT exempt" 1
run "feature/sneaky" "$DB_TITLE" "Bumps serde." "dependabot[bot]"
check "dependabot[bot] on a non-dependabot branch is NOT exempt" 1
run "dependabot/cargo/serde-1.0.2" "$DB_TITLE" "Bumps serde." "dependabot"
check "a look-alike author is NOT exempt" 1
run "dependabot/cargo/serde-1.0.2" "$DB_TITLE" "Bumps serde." "not-dependabot[bot]-really"
check "an author merely containing the bot name is NOT exempt" 1

# --- PR_AUTHOR unset: today's behaviour exactly (no exemption, no set -u crash) --------------------
run "xinquan568/ai/trmx-1-slug" "feat(x): thing (trmx-1)" "Closes #1"
check "PR_AUTHOR unset on a valid human PR still passes" 0
run "dependabot/cargo/serde-1.0.2" "$DB_TITLE" "Bumps serde."
check "PR_AUTHOR unset on a dependabot-shaped PR is refused" 1

[ "$fails" -eq 0 ] && { echo "check-issue-link.test: all passed"; exit 0; }
echo "check-issue-link.test: $fails failure(s)"; exit 1
