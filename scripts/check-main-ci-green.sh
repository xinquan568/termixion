#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Require a GREEN post-merge main CI run for a commit before it may be released (trmx-242, grill H8).
#
# "Wait for post-merge main CI green before tagging" was a human convention; eleven releases in
# sixty-six days were published without CI ever having executed them. This is the gate.
#
# A SCRIPT, not inline workflow YAML, so release.yml and check-main-ci-green.test.sh exercise the
# SAME code — an inline copy plus a re-implemented test can drift while the test stays green.
#
# Env: SHA (commit), R (owner/repo), GH_TOKEN. Optional: SKIP_ANCESTRY=1 (tests only).
# Usage: check-main-ci-green.sh
set -euo pipefail

: "${SHA:?SHA is required}"
: "${R:?R (owner/repo) is required}"

# Filter on PROVENANCE FIRST (workflow identity + push + main), then take the NEWEST run, and only
# THEN judge success. Filtering on success first would let an older green run outrank a newer
# failure for the SAME commit — falsifying the very claim this gate enforces. `ci.yml` also runs on
# pull_request, so matching a job name or a bare status proves nothing about the convention.
if ! runs="$(gh api --paginate "repos/$R/actions/runs?head_sha=$SHA&per_page=100" \
              --jq '.workflow_runs[]
                    | select(.path == ".github/workflows/ci.yml")
                    | select(.event == "push")
                    | select(.head_branch == "main")
                    | "\(.created_at)\t\(.id)\t\(.status)\t\(.conclusion // "none")"')"; then
  echo "::error::could not query workflow runs for $SHA — failing closed." >&2
  exit 1
fi
if [ -z "$runs" ]; then
  echo "::error::no push-to-main ci.yml run found for $SHA — release only a commit whose main CI has run." >&2
  exit 1
fi

# Newest by (created_at, id). The id key MUST sort numerically: a plain lexicographic sort puts
# id 999 after id 1000, so for two runs sharing a timestamp an older run could win and mask a newer
# failure. ISO-8601 timestamps sort correctly lexicographically, hence -k1,1 then -k2,2n.
latest="$(printf '%s\n' "$runs" | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2,2n | tail -1)"
echo "check-main-ci-green: latest push-to-main ci.yml run → $latest"

status="$(printf '%s' "$latest" | cut -f3)"
concl="$(printf '%s' "$latest" | cut -f4)"
if [ "$status" != "completed" ] || [ "$concl" != "success" ]; then
  echo "::error::the LATEST push-to-main ci.yml run for $SHA is status=$status conclusion=$concl — not green." >&2
  exit 1
fi

# Provenance is necessary but not sufficient: confirm the commit is actually on main.
if [ "${SKIP_ANCESTRY:-0}" != "1" ]; then
  git fetch --quiet origin main
  if ! git merge-base --is-ancestor "$SHA" origin/main; then
    echo "::error::$SHA is not an ancestor of origin/main — refusing to release off-main." >&2
    exit 1
  fi
fi

echo "check-main-ci-green: OK — the latest push-to-main ci.yml run is green for $SHA."
