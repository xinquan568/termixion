#!/usr/bin/env bash
# check-issue-link (R9): the authoritative gate that a pull request traces to a GitHub issue. It asserts
# a consistent trmx-<N> across the head branch, the PR title, and the PR body, and that issue #<N> really
# exists (and is an issue, not a PR). Run in CI on `pull_request` — a local `--no-verify` can't bypass it.
# Reads PR metadata from the environment (set by .github/workflows/r9-issue-link.yml), NOT from argv, so
# untrusted PR title/body text is never interpolated into a shell command:
#   HEAD_REF  — PR head branch        (github.event.pull_request.head.ref)
#   PR_TITLE  — PR title
#   PR_BODY   — PR body (may be empty) (github.event.pull_request.body)
#   PR_AUTHOR — PR author login (may be empty) (github.event.pull_request.user.login)
#   REPO      — owner/name            (github.repository)
#   GH_TOKEN  — token for `gh` (issue-existence check)
set -euo pipefail

fail() { echo "r9-issue-link: FAIL — $*" >&2; exit 1; }

: "${HEAD_REF:?HEAD_REF unset}"
: "${PR_TITLE:?PR_TITLE unset}"
: "${REPO:?REPO unset}"
PR_BODY="${PR_BODY:-}"
PR_AUTHOR="${PR_AUTHOR:-}"

# 0. Dependabot allowance (trmx-261). A dependency bump carries no trmx-<N> by construction, and it has no
# design intent to recover from an issue — its provenance is the lockfile diff and the upstream release
# notes. BOTH halves are required. The author login is the authoritative one: GitHub reserves the `[bot]`
# suffix for Apps, so no human account can claim it, and the value comes from the event payload (trusted
# metadata), not from PR-authored text. The branch shape is defence in depth, keeping the exemption narrow
# if the login test is ever loosened — a human PR pushed to a `dependabot/…` branch still faces the full
# gate. `dependabot` is a fixed branch prefix; only the separator is configurable, hence [/-]. R9 itself is
# unchanged: every human PR still needs a consistent trmx-<N> and a real issue.
if [ "$PR_AUTHOR" = "dependabot[bot]" ] && [[ "$HEAD_REF" =~ ^dependabot[/-] ]]; then
  echo "r9-issue-link: OK — exempt: dependabot[bot] dependency PR on '$HEAD_REF' (R9 trmx-<N> is required of human PRs)."
  exit 0
fi

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
