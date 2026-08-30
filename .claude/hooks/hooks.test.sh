#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Self-test for the Termixion git hooks (trmx-239, M24). The hooks' README claimed pre-commit ran
# `cargo fmt --check`, clippy and `pnpm lint`; it ran none of them. That divergence stayed invisible
# because nothing tested what a hook actually invokes — and "run the finished hook and watch it
# pass" is not a test: a hook that runs nothing would pass it.
#
# So this asserts the COMMAND SET each hook invokes, by TRACING it (`bash -x`) rather than by
# stubbing the shell. Only the heavy tools are stubbed — `cargo` and `pnpm` become recorders that
# exit 0 — so the hooks run to completion in milliseconds while the trace records every command,
# including the `bash scripts/<gate>.sh` lines.
#
# (Stubbing `bash` itself, an earlier design, fork-bombs: the stub's own `#!/usr/bin/env bash`
# shebang resolves through PATH straight back to the stub.)
#
# Run: bash .claude/hooks/hooks.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS="$ROOT/.claude/hooks"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0

mkdir -p "$tmp/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/bin/pnpm"
# `cargo` mostly no-ops, but `cargo metadata` must return parseable JSON: pre-commit runs
# check-core-seam.sh, whose gate (c) reads metadata and FAILS CLOSED on unparseable output. An
# exit-0-and-print-nothing stub would therefore make the hook exit 1 for a reason that has nothing
# to do with what this test is asserting. (The exit-status check below caught exactly that.)
cat > "$tmp/bin/cargo" <<'STUB'
#!/usr/bin/env bash
if [ "${1-}" = metadata ]; then printf '{"packages":[]}\n'; fi
exit 0
STUB
# trmx-254: `node` joins the stub set for the same reason as the other two. This test asserts that
# the hooks INVOKE the documented commands, not that the tools succeed — and the shell-integration
# job that runs it never does `pnpm install`, so a real `node scripts/verify-contracts.mjs` cannot
# resolve the TypeScript it parses with and exits 1. That is a missing dependency in the harness, not
# a hook defect, and it is exactly the class the exit-status check above exists to surface.
printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/bin/node"
chmod +x "$tmp/bin/cargo" "$tmp/bin/pnpm" "$tmp/bin/node"

trace=""
run_hook() { # run_hook <name>
  local rc=0
  trace="$tmp/$1.trace"
  ( cd "$ROOT" && PATH="$tmp/bin:$PATH" bash -x "$HOOKS/$1" ) >/dev/null 2>"$trace" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: $1 exited $rc under stubbed tooling — it should succeed"
    fails=$((fails + 1))
  fi
  # xtrace lines look like `+ cmd args` (nested subshells add `+`s). Normalise to the bare command
  # line so assertions can be ANCHORED to the WHOLE line: a substring match would accept
  # `cargo fmt` for the required `cargo fmt --all --check`, or match a longer unrelated command.
  sed -E 's/^\++ //' "$trace" | sed -E "s/^cd .*//" > "$tmp/$1.cmds"
  trace="$tmp/$1.cmds"
}

expect() { # expect <hook> <exact command line>
  local hook="$1" cmd="$2"
  if grep -qxF -- "$cmd" "$trace"; then
    echo "ok: $hook runs \`$cmd\`"
  else
    echo "FAIL: $hook does NOT run \`$cmd\` (exact line)"
    echo "  it ran:"; grep -vE '^$' "$trace" | sed 's/^/    /'
    fails=$((fails + 1))
  fi
}

# --- pre-commit: the fast, staged-content guardrails --------------------------------------------
run_hook pre-commit
expect pre-commit "bash scripts/secret-scan.sh"
expect pre-commit "bash scripts/check-core-seam.sh"
expect pre-commit "bash scripts/check-isc-headers.sh"
expect pre-commit "cargo fmt --all --check"          # trmx-239: claimed by the README, never run
expect pre-commit "pnpm --filter app lint"

# --- pre-push: the heavier gate -------------------------------------------------------------------
run_hook pre-push
expect pre-push "cargo test --workspace --quiet"
expect pre-push "pnpm --filter app test"             # trmx-239: frontend regressions reached only CI
expect pre-push "cargo clippy --workspace --all-targets -- -D warnings"
expect pre-push "node scripts/verify-contracts.mjs"

if [ "$fails" -ne 0 ]; then
  echo "hooks.test: $fails expectation(s) failed." >&2
  exit 1
fi
echo "hooks.test: OK (every documented check is actually invoked)."
