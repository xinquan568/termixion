#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for scripts/secret-scan.sh --range (trmx-234). Builds a throwaway git repo, plants a secret-looking
# line and a credential file on a branch, and asserts the range mode refuses them, passes a clean range, and
# fails LOUDLY (exit 2) on an unresolvable range instead of passing vacuously. The planted token is assembled at
# runtime so no matching secret ever exists in a committed file. Run: bash scripts/secret-scan.test.sh
set -euo pipefail

SCAN="${SECRET_SCAN:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/secret-scan.sh}"
[ -f "$SCAN" ] || { echo "secret-scan.test: scanner not found at $SCAN"; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0
check() { # check <name> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  ok   $1 (exit $3)"; else echo "  FAIL $1: expected exit $2, got $3"; fails=$((fails + 1)); fi
}

git -C "$tmp" init -q -b main
git -C "$tmp" config user.email t@example.com
git -C "$tmp" config user.name t
git -C "$tmp" config commit.gpgsign false
echo "clean" > "$tmp/README"
git -C "$tmp" add README && git -C "$tmp" commit -q -m base

# Branch with a secret-looking added line (AKIA + 16 uppercase alnum, assembled at runtime) and a .pem file.
git -C "$tmp" checkout -q -b leak
printf 'aws_key = "%s%s"\n' 'AKIA' 'IOSFODNN7EXAMPLE' > "$tmp/config.txt"
echo "not really a key" > "$tmp/deploy.pem"
git -C "$tmp" add config.txt deploy.pem && git -C "$tmp" commit -q -m leak

# Clean branch off main.
git -C "$tmp" checkout -q main && git -C "$tmp" checkout -q -b clean
echo "more docs" >> "$tmp/README" && git -C "$tmp" add README && git -C "$tmp" commit -q -m clean

echo "secret-scan.test:"
set +e
out="$(cd "$tmp" && bash "$SCAN" --range main...leak 2>&1)"; rc=$?; set -e
check "range with planted token + .pem is refused" 1 "$rc"
echo "$out" | grep -q 'looks like a secret' || { echo "  FAIL expected the token refusal message"; fails=$((fails + 1)); }
echo "$out" | grep -q 'credential file: deploy.pem' || { echo "  FAIL expected the .pem refusal message"; fails=$((fails + 1)); }

set +e; (cd "$tmp" && bash "$SCAN" --range main...clean >/dev/null 2>&1); rc=$?; set -e
check "clean range passes" 0 "$rc"

set +e; (cd "$tmp" && bash "$SCAN" --range main...no-such-ref >/dev/null 2>&1); rc=$?; set -e
check "unresolvable range fails loudly (never vacuous)" 2 "$rc"

set +e; (cd "$tmp" && bash "$SCAN" >/dev/null 2>&1); rc=$?; set -e
check "legacy staged mode with nothing staged passes" 0 "$rc"

# Malformed invocations must fail LOUDLY (exit 2) — never fall through to a vacuous "no changed files" pass.
expect_usage_error() { # expect_usage_error <argv...>
  set +e; (cd "$tmp" && bash "$SCAN" "$@" >/dev/null 2>&1); rc=$?; set -e
  check "malformed '$*' exits 2" 2 "$rc"
}
expect_usage_error --range --quiet          # option-shaped operand (git would have swallowed it)
expect_usage_error --range HEAD             # no '..' / '...'
expect_usage_error --range main...leak extra # trailing argument
expect_usage_error --range                  # missing operand
expect_usage_error --range main...          # empty right side
expect_usage_error --range ...leak          # empty left side
expect_usage_error --bogus                  # unknown option

[ "$fails" -eq 0 ] && { echo "secret-scan.test: all passed"; exit 0; }
echo "secret-scan.test: $fails failure(s)"; exit 1
