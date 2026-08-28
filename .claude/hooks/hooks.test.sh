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
for tool in cargo pnpm; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$tmp/bin/$tool"
  chmod +x "$tmp/bin/$tool"
done

trace=""
run_hook() { # run_hook <name>
  trace="$tmp/$1.trace"
  ( cd "$ROOT" && PATH="$tmp/bin:$PATH" bash -x "$HOOKS/$1" ) >/dev/null 2>"$trace" || true
}

expect() { # expect <hook> <substring>
  local hook="$1" needle="$2"
  if grep -qF -- "$needle" "$trace"; then
    echo "ok: $hook invokes '$needle'"
  else
    echo "FAIL: $hook does NOT invoke '$needle'"
    fails=$((fails + 1))
  fi
}

# --- pre-commit: the fast, staged-content guardrails --------------------------------------------
run_hook pre-commit
expect pre-commit "scripts/secret-scan.sh"
expect pre-commit "scripts/check-core-seam.sh"
expect pre-commit "scripts/check-isc-headers.sh"
expect pre-commit "cargo fmt"                    # trmx-239: claimed by the README, never run
expect pre-commit "pnpm --filter app lint"

# --- pre-push: the heavier gate -------------------------------------------------------------------
run_hook pre-push
expect pre-push "cargo test --workspace"
expect pre-push "pnpm --filter app test"          # trmx-239: frontend regressions reached only CI
expect pre-push "cargo clippy --workspace --all-targets"

if [ "$fails" -ne 0 ]; then
  echo "hooks.test: $fails expectation(s) failed." >&2
  exit 1
fi
echo "hooks.test: OK (every documented check is actually invoked)."
