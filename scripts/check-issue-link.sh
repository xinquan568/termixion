#!/usr/bin/env bash
# check-issue-link (R9): the authoritative gate that a pull request traces to a GitHub issue. It asserts
# a consistent trmx-<N> across the head branch, the PR title, and the PR body, and that issue #<N> really
# exists (and is an issue, not a PR). Run in CI on `pull_request` — a local `--no-verify` can't bypass it.
# Reads PR metadata from the environment (set by .github/workflows/r9-issue-link.yml), NOT from argv, so
# untrusted PR title/body text is never interpolated into a shell command:
#   HEAD_REF  — PR head branch        (github.event.pull_request.head.ref)
#   PR_TITLE  — PR title
#   PR_BODY   — PR body (may be empty) (github.event.pull_request.body)
#   REPO      — owner/name            (github.repository)
#   GH_TOKEN  — token for `gh` (issue-existence check)
set -euo pipefail

fail() { echo "r9-issue-link: FAIL — $*" >&2; exit 1; }

: "${HEAD_REF:?HEAD_REF unset}"
: "${PR_TITLE:?PR_TITLE unset}"
: "${REPO:?REPO unset}"
PR_BODY="${PR_BODY:-}"

# 1. Head branch must carry trmx-<N> (e.g. xinquan568/ai/trmx-<N>-<slug>).
[[ "$HEAD_REF" =~ trmx-([0-9]+) ]] || fail "branch '$HEAD_REF' has no trmx-<N> (expected …/trmx-<N>-<slug>)"
branch_n="${BASH_REMATCH[1]}"

# 2. PR title must end with (trmx-<N>).
[[ "$PR_TITLE" =~ \(trmx-([0-9]+)\)[[:space:]]*$ ]] || fail "PR title must end with (trmx-<N>); got: $PR_TITLE"
title_n="${BASH_REMATCH[1]}"

# 3. Branch and title must agree.
[ "$branch_n" = "$title_n" ] || fail "trmx mismatch: branch trmx-$branch_n vs title trmx-$title_n"

# 4. PR body must reference #<N> for the SAME N (Closes/Fixes/Refs #N, or a bare #N).
if ! grep -oE '#[0-9]+' <<<"$PR_BODY" | tr -d '#' | grep -qx "$branch_n"; then
  fail "PR body must link the issue for trmx-$branch_n (e.g. 'Closes #$branch_n')"
fi

# 5. Issue #<N> must exist AND be an issue. The REST API exposes PRs under /issues too, so reject those.
kind="$(gh api "repos/$REPO/issues/$branch_n" --jq 'if has("pull_request") then "pr" else "issue" end' 2>/dev/null)" \
  || fail "issue #$branch_n (trmx-$branch_n) not found in $REPO"
[ "$kind" = "issue" ] || fail "#$branch_n is a pull request, not an issue — trmx-<N> must reference an issue"

echo "r9-issue-link: OK — trmx-$branch_n consistent across branch / title / body, and issue #$branch_n exists."
